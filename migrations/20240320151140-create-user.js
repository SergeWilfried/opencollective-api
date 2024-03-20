'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {
    await queryInterface.createTable('Users', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      CollectiveId: {
        type: Sequelize.INTEGER,
        references: { model: 'Collectives', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      email: {
        type: Sequelize.STRING,
        allowNull: false,
        unique: true,
      },
      emailWaitingForValidation: {
        type: Sequelize.STRING,
        unique: true,
      },
      emailConfirmationToken: {
        type: Sequelize.STRING,
      },
      createdAt: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.NOW,
      },
      updatedAt: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.NOW,
      },
      deletedAt: {
        type: Sequelize.DATE,
      },
      confirmedAt: {
        type: Sequelize.DATE,
      },
      lastLoginAt: {
        type: Sequelize.DATE,
      },
      newsletterOptIn: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      data: {
        type: Sequelize.JSONB,
      },
      twoFactorAuthToken: {
        type: Sequelize.STRING,
      },
      yubikeyDeviceId: {
        type: Sequelize.STRING,
      },
      twoFactorAuthRecoveryCodes: {
        type: Sequelize.ARRAY(Sequelize.STRING),
      },
      changelogViewDate: {
        type: Sequelize.DATE,
      },
      passwordHash: {
        type: Sequelize.STRING,
      },
      passwordUpdatedAt: {
        type: Sequelize.DATE,
      },
    }, {
      paranoid: true, // This enables soft deletes by adding a deletedAt timestamp.
    });
  },

  async down (queryInterface, Sequelize) {
    await queryInterface.dropTable('Users');
  }
};
