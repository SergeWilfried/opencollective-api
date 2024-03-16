import cryptoRandomString from 'crypto-random-string';
import express from 'express';
import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLFloat,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
} from 'graphql';
import { GraphQLJSON, GraphQLNonEmptyString } from 'graphql-scalars';
import { cloneDeep, isNull, omitBy, pick, set } from 'lodash';

import activities from '../../../constants/activities';
import { CollectiveType } from '../../../constants/collectives';
import * as collectivelib from '../../../lib/collectivelib';
import { duplicateAccount } from '../../../lib/duplicate-account';
import { crypto } from '../../../lib/encryption';
import TwoFactorAuthLib, { TwoFactorMethod } from '../../../lib/two-factor-authentication';
import * as webauthn from '../../../lib/two-factor-authentication/webauthn';
import { validateYubikeyOTP } from '../../../lib/two-factor-authentication/yubikey-otp';
import models, { Collective, sequelize } from '../../../models';
import UserTwoFactorMethod from '../../../models/UserTwoFactorMethod';
import { sendMessage } from '../../common/collective';
import { checkRemoteUserCanUseAccount, checkRemoteUserCanUseHost } from '../../common/scope-check';
import { BadRequest, Forbidden, NotFound, Unauthorized, ValidationFailed } from '../../errors';
import { AccountTypeToModelMapping } from '../enum/AccountType';
import { GraphQLTwoFactorMethodEnum } from '../enum/TwoFactorMethodEnum';
import { idDecode } from '../identifiers';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { GraphQLAccountUpdateInput } from '../input/AccountUpdateInput';
import { GraphQLDuplicateAccountDataTypeInput } from '../input/DuplicateAccountDataTypeInput';
import { GraphQLPoliciesInput } from '../input/PoliciesInput';
import {
  fetchUserTwoFactorMethodWithReference,
  GraphQLUserTwoFactorMethodReferenceInput,
} from '../input/UserTwoFactorMethodReferenceInput';
import { GraphQLAccount } from '../interface/Account';
import { GraphQLHost } from '../object/Host';
import { GraphQLIndividual } from '../object/Individual';
import GraphQLAccountSettingsKey from '../scalar/AccountSettingsKey';

const GraphQLAddTwoFactorAuthTokenToIndividualResponse = new GraphQLObjectType({
  name: 'AddTwoFactorAuthTokenToIndividualResponse',
  description: 'Response for the addTwoFactorAuthTokenToIndividual mutation',
  fields: () => ({
    account: {
      type: new GraphQLNonNull(GraphQLIndividual),
      description: 'The Individual that the 2FA has been enabled for',
    },
    recoveryCodes: {
      type: new GraphQLList(GraphQLString),
      description: 'The recovery codes for the Individual to write down',
    },
  }),
});

const accountMutations = {
  duplicateAccount: {
    type: new GraphQLNonNull(GraphQLAccount),
    description: 'Duplicate an account. Scope: "account".',
    args: {
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Account to duplicate',
      },
      newSlug: {
        type: GraphQLString,
        description: 'The new slug for the duplicated account. Defaults to an autogenerated slug',
      },
      newName: {
        type: GraphQLString,
        description: 'The new name for the duplicated account. Defaults to the same as the original account',
      },
      oldName: {
        type: GraphQLString,
        description: 'Use this if you want to rename the original account',
      },
      include: {
        type: GraphQLDuplicateAccountDataTypeInput,
        description: 'Which data should be copied when duplicating the account',
      },
      connect: {
        type: new GraphQLNonNull(GraphQLBoolean),
        description: 'Whether to mark both accounts as connected',
        defaultValue: false,
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<Collective> {
      checkRemoteUserCanUseAccount(req);

      const account = await fetchAccountWithReference(args.account, { throwIfMissing: true });
      if (!req.remoteUser.isAdminOfCollective(account)) {
        throw new Forbidden('You need to be logged in as an Admin of the account to duplicate it.');
      } else if (![CollectiveType.COLLECTIVE, CollectiveType.FUND].includes(account.type)) {
        throw new ValidationFailed(`${account.type} accounts cannot be duplicated.`);
      }

      return duplicateAccount(
        account,
        req.remoteUser,
        pick(args, ['newSlug', 'newName', 'oldName', 'include', 'connect']),
      );
    },
  },
  editAccountSetting: {
    type: new GraphQLNonNull(GraphQLAccount),
    description: 'Edit the settings for the given account. Scope: "account" or "host".',
    args: {
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Account where the settings will be updated',
      },
      key: {
        type: new GraphQLNonNull(GraphQLAccountSettingsKey),
        description: 'The key that you want to edit in settings',
      },
      value: {
        type: new GraphQLNonNull(GraphQLJSON),
        description: 'The value to set for this key',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<Record<string, unknown>> {
      if (!req.remoteUser) {
        throw new Unauthorized();
      }

      return sequelize.transaction(async transaction => {
        const account = await fetchAccountWithReference(args.account, {
          dbTransaction: transaction,
          lock: true,
          throwIfMissing: true,
        });

        const isKeyEditableByHostAdmins = ['expenseTypes'].includes(args.key);
        const permissionMethod = isKeyEditableByHostAdmins ? 'isAdminOfCollectiveOrHost' : 'isAdminOfCollective';
        if (!req.remoteUser[permissionMethod](account)) {
          throw new Forbidden();
        }

        // If the user is not admin and was not Forbidden, it means it's the Host and we check "host" scope
        if (!req.remoteUser.isAdminOfCollective(account)) {
          checkRemoteUserCanUseHost(req);
        } else {
          checkRemoteUserCanUseAccount(req);
        }

        // Enforce 2FA if trying to change 2FA rolling limit settings while it's already enabled
        if (args.key.split('.')[0] === 'payoutsTwoFactorAuth' && account.settings?.payoutsTwoFactorAuth?.enabled) {
          await TwoFactorAuthLib.validateRequest(req, {
            alwaysAskForToken: true,
            requireTwoFactorAuthEnabled: true,
            FromCollectiveId: account.id,
          });
        }

        if (
          args.key === 'collectivePage' &&
          ![AccountTypeToModelMapping.FUND, AccountTypeToModelMapping.PROJECT].includes(account.type)
        ) {
          const budgetSection = args.value.sections?.find(s => s.section === 'budget');
          if (budgetSection && !budgetSection.isEnabled) {
            throw new Forbidden();
          }
        }

        const settings = account.settings ? cloneDeep(account.settings) : {};
        set(settings, args.key, args.value);

        const previousData = { settings: { [args.key]: account.data?.[args.key] } };
        const updatedAccount = await account.update({ settings }, { transaction });
        await models.Activity.create(
          {
            type: activities.COLLECTIVE_EDITED,
            UserId: req.remoteUser.id,
            UserTokenId: req.userToken?.id,
            CollectiveId: account.id,
            FromCollectiveId: account.id,
            HostCollectiveId: account.approvedAt ? account.HostCollectiveId : null,
            data: {
              previousData,
              newData: { settings: { [args.key]: args.value } },
            },
          },
          { transaction },
        );

        return updatedAccount;
      });
    },
  },
  editAccountFeeStructure: {
    type: new GraphQLNonNull(GraphQLAccount),
    description: 'An endpoint for hosts to edit the fees structure of their hosted accounts. Scope: "host".',
    args: {
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Account where the settings will be updated',
      },
      hostFeePercent: {
        type: new GraphQLNonNull(GraphQLFloat),
        description: 'The host fee percent to apply to this account',
      },
      isCustomFee: {
        type: new GraphQLNonNull(GraphQLBoolean),
        description: 'If using a custom fee, set this to true',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<Record<string, unknown>> {
      checkRemoteUserCanUseHost(req);

      return sequelize.transaction(async dbTransaction => {
        const account = await fetchAccountWithReference(args.account, {
          throwIfMissing: true,
          dbTransaction,
          lock: true,
        });

        if (!account.HostCollectiveId) {
          throw new ValidationFailed('Fees structure can only be edited for accounts that you are hosting');
        } else if (!req.remoteUser?.isAdmin(account.HostCollectiveId)) {
          throw new Forbidden(
            'You need to be logged in as an host admin to change the fees structure of the hosted accounts',
          );
        } else if (!account.approvedAt) {
          throw new ValidationFailed('The collective needs to be approved before you can change the fees structure');
        }

        const host = await models.Collective.findByPk(account.HostCollectiveId, { transaction: dbTransaction });
        const hostFeePercent = args.isCustomFee ? args.hostFeePercent : host.hostFeePercent;
        const updateAccountFees = async account => {
          return account.update(
            {
              hostFeePercent,
              data: { ...account.data, useCustomHostFee: args.isCustomFee },
            },
            { transaction: dbTransaction },
          );
        };

        const previousData = {
          hostFeePercent: account.hostFeePercent,
          useCustomHostFee: account.data?.useCustomHostFee,
        };

        // Update main account
        await updateAccountFees(account);

        // Cascade host update to events and projects
        // Passing platformFeePercent through options so we don't request the parent collective on every children update
        const children = await account.getChildren({ transaction: dbTransaction });
        if (children.length > 0) {
          await Promise.all(children.map(updateAccountFees));
        }

        await models.Activity.create(
          {
            type: activities.COLLECTIVE_EDITED,
            UserId: req.remoteUser.id,
            UserTokenId: req.userToken?.id,
            CollectiveId: account.id,
            FromCollectiveId: account.id,
            HostCollectiveId: account.HostCollectiveId,
            data: {
              previousData,
              newData: { hostFeePercent: args.hostFeePercent, useCustomHostFee: args.isCustomFee },
            },
          },
          { transaction: dbTransaction },
        );

        return account;
      });
    },
  },
  editAccountFreezeStatus: {
    type: new GraphQLNonNull(GraphQLAccount),
    description: 'An endpoint for hosts to edit the freeze status of their hosted accounts. Scope: "host".',
    args: {
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Account to freeze',
      },
      action: {
        type: new GraphQLNonNull(
          new GraphQLEnumType({ name: 'AccountFreezeAction', values: { FREEZE: {}, UNFREEZE: {} } }),
        ),
      },
      message: {
        type: GraphQLString,
        description: 'Message to send by email to the admins of the account',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<Collective> {
      checkRemoteUserCanUseHost(req);

      const account = await fetchAccountWithReference(args.account, { throwIfMissing: true });
      account.host = await account.getHostCollective({ loaders: req.loaders });
      if (!account.host) {
        throw new ValidationFailed('Cannot find the host of this account');
      } else if (!req.remoteUser.isAdminOfCollective(account.host)) {
        throw new Unauthorized();
      } else if (![CollectiveType.COLLECTIVE, CollectiveType.FUND].includes(account.type)) {
        throw new ValidationFailed(
          'Only collective and funds can be frozen. To freeze children accounts (projects, events) you need to freeze the parent account.',
        );
      }

      if (args.action === 'FREEZE') {
        await account.freeze(args.message);
      } else if (args.action === 'UNFREEZE') {
        await account.unfreeze(args.message);
      }

      return account.reload();
    },
  },
  createWebAuthnRegistrationOptions: {
    type: new GraphQLNonNull(GraphQLJSON),
    description: 'Create WebAuthn public key registration request options',
    args: {
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Account that will create a WebAuthn registration',
      },
    },
    async resolve(_: void, args, req: express.Request) {
      checkRemoteUserCanUseAccount(req);

      const account = await fetchAccountWithReference(args.account);

      if (!req.remoteUser.isAdminOfCollective(account)) {
        throw new Forbidden();
      }

      const user = await models.User.findOne({ where: { CollectiveId: account.id } });

      if (!user) {
        throw new NotFound('Account not found.');
      }

      const options = await webauthn.generateRegistrationOptions(user, req);
      return options;
    },
  },
  addTwoFactorAuthTokenToIndividual: {
    type: new GraphQLNonNull(GraphQLAddTwoFactorAuthTokenToIndividualResponse),
    description: 'Add 2FA to the Individual if it does not have it. Scope: "account".',
    args: {
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Individual that will have 2FA added to it',
      },
      type: {
        type: GraphQLTwoFactorMethodEnum,
        description: 'The two factor method to add, defaults to TOTP',
      },
      token: {
        type: new GraphQLNonNull(GraphQLString),
        description: 'The generated secret to save to the Individual',
      },
    },
    async resolve(
      _: void,
      args: { account: Record<string, unknown>; type?: TwoFactorMethod; token: string },
      req: express.Request,
    ): Promise<Record<string, unknown>> {
      checkRemoteUserCanUseAccount(req);

      const account = await fetchAccountWithReference(args.account);

      if (!req.remoteUser.isAdminOfCollective(account)) {
        throw new Forbidden();
      }

      const user = await models.User.findOne({ where: { CollectiveId: account.id } });

      if (!user) {
        throw new NotFound('Account not found.');
      }

      const type = (args.type as TwoFactorMethod) || TwoFactorMethod.TOTP;
      const userEnabledMethods = await TwoFactorAuthLib.twoFactorMethodsSupportedByUser(user);

      if (userEnabledMethods.length > 0) {
        await TwoFactorAuthLib.validateRequest(req, { alwaysAskForToken: true });
      }

      switch (type) {
        case TwoFactorMethod.TOTP: {
          /*
          check that base32 secret is only capital letters, numbers (2-7), 103 chars long;
          Our secret is 64 ascii characters which is encoded into 104 base32 characters
          (base32 should be divisible by 8). But the last character is an = to pad, and
          speakeasy library cuts out any = padding
          **/
          const verifyToken = args.token.match(/([A-Z2-7]){103}/);
          if (!verifyToken) {
            throw new ValidationFailed('Invalid 2FA token');
          }

          const encryptedText = crypto.encrypt(args.token);
          await UserTwoFactorMethod.create({
            UserId: user.id,
            method: TwoFactorMethod.TOTP,
            name: 'Authenticator',
            data: {
              secret: encryptedText,
            },
          });
          break;
        }
        case TwoFactorMethod.YUBIKEY_OTP: {
          const validYubikeyOTP = await validateYubikeyOTP(args.token);

          if (!validYubikeyOTP) {
            throw new ValidationFailed('Invalid 2FA token');
          }

          await UserTwoFactorMethod.create({
            UserId: user.id,
            method: TwoFactorMethod.YUBIKEY_OTP,
            name: `Yubikey ${args.token.substring(0, 12)}`,
            data: {
              yubikeyDeviceId: args.token.substring(0, 12),
            },
          });

          break;
        }
        case TwoFactorMethod.WEBAUTHN: {
          const registrationResult = JSON.parse(Buffer.from(args.token, 'base64').toString('utf8'));
          const registrationResponse = await webauthn.verifyRegistrationResponse(user, req, registrationResult);

          const data = await webauthn.getWebauthDeviceData(registrationResponse);

          const name = data.description || 'U2F device';

          await UserTwoFactorMethod.create({
            UserId: user.id,
            method: TwoFactorMethod.WEBAUTHN,
            name,
            data,
          });

          break;
        }
        default: {
          throw new ValidationFailed('Unsupported 2FA method');
        }
      }

      let recoveryCodesArray;
      if (userEnabledMethods.length === 0) {
        /** Generate recovery codes, hash and store them in the table, and return them to the user to write down */
        recoveryCodesArray = Array.from({ length: 6 }, () =>
          cryptoRandomString({ length: 16, type: 'distinguishable' }),
        );
        const hashedRecoveryCodesArray = recoveryCodesArray.map(code => {
          return crypto.hash(code);
        });
        await user.update({ twoFactorAuthRecoveryCodes: hashedRecoveryCodesArray });
      }

      await models.Activity.create({
        type: activities.TWO_FACTOR_METHOD_ADDED,
        UserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: user.CollectiveId,
      });

      return { account: account, recoveryCodes: recoveryCodesArray };
    },
  },
  removeTwoFactorAuthTokenFromIndividual: {
    type: new GraphQLNonNull(GraphQLIndividual),
    description: 'Remove 2FA from the Individual if it has been enabled. Scope: "account".',
    args: {
      userTwoFactorMethod: {
        type: GraphQLUserTwoFactorMethodReferenceInput,
        description: 'Method to remove from this account',
      },
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Account that will have 2FA removed from it',
      },
      type: {
        type: GraphQLTwoFactorMethodEnum,
        deprecationReason: '2023-08-01: Use the two factor method reference to specify method to remove',
        description: 'The two factor method to remove. Removes all if empty',
      },
      code: {
        type: GraphQLString,
        deprecationReason: '2023-08-01: 2FA code to validate this action must be set via 2FA header',
        description: 'The 6-digit 2FA code',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<Collective> {
      checkRemoteUserCanUseAccount(req);

      const account = await fetchAccountWithReference(args.account);

      if (!req.remoteUser.isAdminOfCollective(account)) {
        throw new Forbidden();
      }

      let userTwoFactorMethod: UserTwoFactorMethod<Exclude<TwoFactorMethod, TwoFactorMethod.RECOVERY_CODE>>;
      if (args.userTwoFactorMethod) {
        userTwoFactorMethod = await fetchUserTwoFactorMethodWithReference(args.userTwoFactorMethod, {
          throwIfMissing: true,
        });

        if (userTwoFactorMethod.UserId !== req.remoteUser.id) {
          throw new Forbidden();
        }
      }

      const user = await models.User.findOne({ where: { CollectiveId: account.id } });

      if (!user) {
        throw new NotFound('Account not found.');
      }

      if ((await TwoFactorAuthLib.twoFactorMethodsSupportedByUser(user)).length === 0) {
        throw new Unauthorized('This account already has 2FA disabled.');
      }

      await TwoFactorAuthLib.validateRequest(req, {
        requireTwoFactorAuthEnabled: true,
        alwaysAskForToken: true,
      });

      if (userTwoFactorMethod) {
        await userTwoFactorMethod.destroy();
      } else {
        await UserTwoFactorMethod.destroy({
          where: {
            UserId: user.id,
            ...(args.type ? { method: args.type as TwoFactorMethod } : {}),
          },
        });
      }

      if ((await TwoFactorAuthLib.twoFactorMethodsSupportedByUser(user)).length === 0) {
        await user.update({ twoFactorAuthRecoveryCodes: null });
      }

      await models.Activity.create({
        type: activities.TWO_FACTOR_METHOD_DELETED,
        UserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: user.CollectiveId,
        UserTokenId: req.userToken?.id,
        data: {
          userTwoFactorMethod: userTwoFactorMethod?.info,
        },
      });

      return account;
    },
  },
  editTwoFactorAuthenticationMethod: {
    type: new GraphQLNonNull(GraphQLIndividual),
    description: 'Edit 2FA method',
    args: {
      userTwoFactorMethod: {
        type: new GraphQLNonNull(GraphQLUserTwoFactorMethodReferenceInput),
        description: 'Method to edit',
      },
      name: {
        type: GraphQLString,
        description: 'New name for the method',
      },
    },
    async resolve(_: void, args, req: express.Request) {
      const userTwoFactorMethod = await fetchUserTwoFactorMethodWithReference(args.userTwoFactorMethod, {
        throwIfMissing: true,
      });
      const account = await req.remoteUser.getCollective({ loaders: req.loaders });

      if (!req.remoteUser.isAdminOfCollective(account)) {
        throw new Forbidden();
      }

      await userTwoFactorMethod.update({
        name: args.name,
      });

      return account;
    },
  },
  editAccount: {
    type: new GraphQLNonNull(GraphQLHost),
    description: 'Edit key properties of an account. Scope: "account".',
    args: {
      account: {
        type: new GraphQLNonNull(GraphQLAccountUpdateInput),
        description: 'Account to edit.',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<Record<string, unknown>> {
      checkRemoteUserCanUseAccount(req);

      const id = idDecode(args.account.id, 'account');
      const account = await req.loaders.Collective.byId.load(id);
      if (!account) {
        throw new NotFound('Account Not Found');
      }

      if (!req.remoteUser.isAdminOfCollective(account) && !req.remoteUser.isRoot()) {
        throw new Forbidden();
      }

      await TwoFactorAuthLib.enforceForAccount(req, account, { onlyAskOnLogin: true });

      for (const key of Object.keys(args.account)) {
        switch (key) {
          case 'currency': {
            const previousData = { currency: account.currency };
            await account.setCurrency(args.account[key]);
            await models.Activity.create({
              type: activities.COLLECTIVE_EDITED,
              UserId: req.remoteUser.id,
              UserTokenId: req.userToken?.id,
              CollectiveId: account.id,
              FromCollectiveId: account.id,
              HostCollectiveId: account.approvedAt ? account.HostCollectiveId : null,
              data: { previousData, newData: { currency: args.account[key] } },
            });
          }
        }
      }

      return account;
    },
  },
  setPolicies: {
    type: new GraphQLNonNull(GraphQLAccount),
    description: 'Adds or removes a policy on a given account. Scope: "account".',
    args: {
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Account where the policies are being set',
      },
      policies: {
        type: new GraphQLNonNull(GraphQLPoliciesInput),
        description: 'The policy to be added',
      },
    },

    async resolve(_: void, args, req: express.Request): Promise<void> {
      checkRemoteUserCanUseAccount(req);

      const id = args.account.legacyId || idDecode(args.account.id, 'account');
      const account = await req.loaders.Collective.byId.load(id);
      if (!account) {
        throw new NotFound('Account Not Found');
      }

      if (!req.remoteUser.isAdminOfCollective(account)) {
        throw new Unauthorized();
      }

      // Merge submitted policies with existing ones
      const previousPolicies = account.data?.policies;
      const newPolicies = omitBy({ ...previousPolicies, ...args.policies }, isNull);

      // Enforce 2FA when trying to disable `REQUIRE_2FA_FOR_ADMINS`
      if (previousPolicies?.REQUIRE_2FA_FOR_ADMINS && !newPolicies.REQUIRE_2FA_FOR_ADMINS) {
        await TwoFactorAuthLib.validateRequest(req, {
          alwaysAskForToken: true,
          requireTwoFactorAuthEnabled: true,
          FromCollectiveId: account.id,
        });
      }

      await account.setPolicies(newPolicies);
      await models.Activity.create({
        type: activities.COLLECTIVE_EDITED,
        UserId: req.remoteUser.id,
        UserTokenId: req.userToken?.id,
        CollectiveId: account.id,
        FromCollectiveId: account.id,
        HostCollectiveId: account.approvedAt ? account.HostCollectiveId : null,
        data: { previousData: { policies: previousPolicies }, newData: { policies: newPolicies } },
      });

      return account;
    },
  },
  deleteAccount: {
    type: GraphQLAccount,
    description: 'Adds or removes a policy on a given account. Scope: "account".',
    args: {
      account: {
        description: 'Reference to the Account to be deleted.',
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
      },
    },
    async resolve(_, args, req) {
      checkRemoteUserCanUseAccount(req);

      const id = args.account.legacyId || idDecode(args.account.id, 'account');
      const account = await req.loaders.Collective.byId.load(id);
      if (!account) {
        throw new NotFound('Account Not Found');
      }

      if (!req.remoteUser.isAdminOfCollective(account)) {
        throw new Unauthorized('You need to be logged in as an Admin of the account.');
      }

      await TwoFactorAuthLib.enforceForAccount(req, account, { alwaysAskForToken: true });

      if (await account.isHost()) {
        throw new Error(
          `You can't delete an account activated as Host. Please, desactivate the account as Host and try again.`,
        );
      }

      if (!(await collectivelib.isCollectiveDeletable(account))) {
        throw new Error(
          `You can't delete an Account with admin memberships, children, transactions, orders or expenses. Please archive it instead.`,
        );
      }

      return collectivelib.deleteCollective(account);
    },
  },
  sendMessage: {
    type: new GraphQLObjectType({
      name: 'SendMessageResult',
      fields: {
        success: { type: GraphQLBoolean },
      },
    }),
    description: 'Send a message to an account. Scope: "account"',
    args: {
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Reference to the Account to send message to.',
      },
      message: {
        type: new GraphQLNonNull(GraphQLNonEmptyString),
        description: 'Message to send to the account.',
      },
      subject: { type: GraphQLString },
    },
    async resolve(_, args, req) {
      const account = await fetchAccountWithReference(args.account, { throwIfMissing: true });

      return sendMessage({ req, args, collective: account, isGqlV2: true });
    },
  },
  regenerateRecoveryCodes: {
    type: new GraphQLList(new GraphQLNonNull(GraphQLString)),
    description: 'Regenerate two factor authentication recovery codes',
    async resolve(_, args, req) {
      checkRemoteUserCanUseAccount(req);

      const hasTwoFactorEnabled = await TwoFactorAuthLib.userHasTwoFactorAuthEnabled(req.remoteUser);
      if (!hasTwoFactorEnabled) {
        throw new BadRequest('User does not have two factor authetication enabled');
      }

      await TwoFactorAuthLib.validateRequest(req, { alwaysAskForToken: true });

      const recoveryCodesArray = Array.from({ length: 6 }, () =>
        cryptoRandomString({ length: 16, type: 'distinguishable' }),
      );
      const hashedRecoveryCodesArray = recoveryCodesArray.map(code => {
        return crypto.hash(code);
      });
      await req.remoteUser.update({ twoFactorAuthRecoveryCodes: hashedRecoveryCodesArray });

      return recoveryCodesArray;
    },
  },
};

export default accountMutations;
