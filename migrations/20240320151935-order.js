'use strict';

module.exports = {
  async up (queryInterface, Sequelize) {
    await queryInterface.createTable('Orders', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      CreatedByUserId: {
        type: Sequelize.INTEGER,
        references: {
          model: 'Users',
          key: 'id',
        },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      FromCollectiveId: {
        type: Sequelize.INTEGER,
        references: {
          model: 'Collectives',
          key: 'id',
        },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        allowNull: false,
      },
      CollectiveId: {
        type: Sequelize.INTEGER,
        references: {
          model: 'Collectives',
          key: 'id',
        },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        allowNull: false,
      },
      TierId: {
        type: Sequelize.INTEGER,
        references: {
          model: 'Tiers',
          key: 'id',
        },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      quantity: {
        type: Sequelize.INTEGER,
        validate: {
          min: 1,
        },
      },
      currency: {
        type: Sequelize.STRING, // Adjust according to CustomDataTypes if necessary
      },
      tags: {
        type: Sequelize.ARRAY(Sequelize.STRING),
        allowNull: true,
      },
      totalAmount: {
        type: Sequelize.INTEGER,
        validate: {
          min: 0,
        },
      },
      platformTipAmount: {
        type: Sequelize.INTEGER,
        allowNull: true,
        defaultValue: null,
      },
      platformTipEligible: {
        type: Sequelize.BOOLEAN,
        allowNull: true,
        defaultValue: null,
      },
      taxAmount: {
        type: Sequelize.INTEGER,
        validate: {
          min: 0,
        },
      },
      description: Sequelize.STRING,
      publicMessage: Sequelize.STRING,
      privateMessage: Sequelize.STRING,
      SubscriptionId: {
        type: Sequelize.INTEGER,
        references: {
          model: 'Subscriptions',
          key: 'id',
        },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      AccountingCategoryId: {
        type: Sequelize.INTEGER,
        references: {
          model: 'AccountingCategories',
          key: 'id',
        },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        allowNull: true,
      },
      PaymentMethodId: {
        type: Sequelize.INTEGER,
        references: {
          model: 'PaymentMethods',
          key: 'id',
        },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      processedAt: Sequelize.DATE,
      status: {
        type: Sequelize.STRING,
        defaultValue: 'NEW',
        allowNull: false,
      },
      interval: Sequelize.STRING,
      data: Sequelize.JSONB,
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
    }, {
      paranoid: true,
    });
  },

  async down (queryInterface, Sequelize) {
    await queryInterface.dropTable('Orders');
  }
};
