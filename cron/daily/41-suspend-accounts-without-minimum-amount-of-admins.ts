import '../../server/env';

import { roles } from '../../server/constants';
import FEATURE from '../../server/constants/feature';
import POLICIES from '../../server/constants/policies';
import logger from '../../server/lib/logger';
import { getPolicy } from '../../server/lib/policies';
import models from '../../server/models';
import { runCronJob } from '../utils';

const run = async () => {
  const collectives = await models.Collective.findAll({
    where: {
      // Since children automatically inherit the policies, features and admins of their parent, we only need to check the parent collectives
      ParentCollectiveId: null,
    },
    include: [
      { model: models.Member, as: 'members', where: { role: roles.ADMIN } },
      {
        model: models.Collective,
        as: 'host',
        required: true,
        where: {
          data: {
            policies: {
              COLLECTIVE_MINIMUM_ADMINS: { applies: 'ALL_COLLECTIVES', freeze: true },
            },
          },
        },
      },
    ],
  });

  for (const collective of collectives) {
    const admins = collective.members.length;
    const minAdminsPolicy = await getPolicy(collective.host, POLICIES.COLLECTIVE_MINIMUM_ADMINS);
    const requiredAdmins = minAdminsPolicy?.numberOfAdmins;
    if (admins < requiredAdmins) {
      logger.info(
        `Collective ${collective.slug} has ${admins} out of ${requiredAdmins} required admins, suspending donations.`,
      );
      await collective.disableFeature(FEATURE.RECEIVE_FINANCIAL_CONTRIBUTIONS);
    }
  }
};

if (require.main === module) {
  runCronJob('suspend-accounts-without-minimum-amount-of-admins', run, 24 * 60 * 60);
}
