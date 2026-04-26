const express = require("express");
const router = express.Router();
const { restrictTo } = require("../middlewares/auth");
const routeRegistry = require("../utils/routeRegistry");

// Base URL configuration for assets and links
const BASE_URL = process.env.BASE_URL || "http://localhost:8000";

// Import models
const User = require("../models/user");
const Product = require("../models/product");
const Blog = require("../models/blog");
const Order = require("../models/order");
const Category = require("../models/category");
const Complain = require("../models/complain");
const Company = require("../models/company");
const Branch = require("../models/branch");
const Account = require("../models/account");
const Warehouse = require("../models/warehouse");
const Integration = require("../models/integration");
const stockTransferController = require("../controllers/stockTransfer");
const Process = require("../models/process");
const Brands = require("../models/brands");
const Attribute = require("../models/attribute");
const Logs = require("../models/logs");
// Import CRUD generators
const adminCrudGenerator = require("../utils/adminCrudGenerator");

/**
 * Auto-generate Admin CRUD with UI Forms for User model
 */
const userAdminCRUD = adminCrudGenerator(
  User,
  "users",
  // Order controls how fields appear in the admin form. We insert permissions next to role-related settings.
  [
    "name",
    "email",
    "password",
    "role",
    "permissions",
    "profile_image",
    "company_id",
  ],
  {
    // Custom options for User model
    excludedFields: ["__v", "password"],
    includedFields: [
      "name",
      "email",
      "role",
      "profile_image",
      "company_id",
      "createdAt",
    ],
    searchableFields: ["name", "email"],
    filterableFields: ["role"],
    sortableFields: ["name", "email", "createdAt"],
    // Base URL for assets
    softDelete: true, // Enable soft delete functionality
    baseUrl: BASE_URL,
    // Custom validation
    validation: {
      insert: async (data) => {
        const errors = [];

        if (!data.name || data.name.trim().length < 2) {
          errors.push({
            field: "name",
            message: "Name must be at least 2 characters",
          });
        }

        if (!data.email || !data.email.includes("@")) {
          errors.push({ field: "email", message: "Valid email is required" });
        }

        if (!data.password || data.password.length < 6) {
          errors.push({
            field: "password",
            message: "Password must be at least 6 characters",
          });
        }

        return {
          isValid: errors.length === 0,
          errors,
        };
      },
    },
    // Custom field types
    fieldTypes: {
      role: "multiselect",
      profile_image: "file",
      company_id: "select",
      password: "password",
      permissions: "custom",
    },
    listHiddenFields: ["permissions"],
    // Custom field options
    fieldOptions: {
      role: [
        { value: "USER", label: "User" },
        { value: "ADMIN", label: "Admin" },
        { value: "VENDOR", label: "Vendor" },
        { value: "CUSTOMER", label: "Customer" },
      ],
      company_id: [], // Will be populated dynamically
      // Configure the permission matrix once—modules become rows, actions become columns.
      permissions: {
        modules: [
          { key: "integration", label: "Integration" },
          { key: "orders", label: "Orders" },
          { key: "analytics", label: "Analytics" },
          { key: "inventory", label: "Inventory" },
        ],
        actions: [
          { key: "view", label: "View" },
          { key: "edit", label: "Edit" },
          { key: "delete", label: "Delete" },
        ],
      },
    },
    // Custom field labels
    fieldLabels: {
      profile_image: "Profile Image",
      password: "Password",
      company_id: "Company",
      permissions: "Permissions",
    },

    middleware: {
      afterQuery: async (records, req) => {
        // Populate both company_id and created_by
        const populatedRecords = await Integration.populate(records, [
          { path: "company_id", select: "company_name" },
          { path: "created_by", select: "name email" },
        ]);

        // Add both User name and Company name fields for display in list view
        const recordsWithPopulatedFields = populatedRecords.map((record) => {
          const recordObj = record.toObject ? record.toObject() : record;

          // Handle created_by field
          if (record.created_by) {
            recordObj.created_by = record.created_by.name || "No User";
          } else {
            recordObj.created_by = "No User";
          }

          // Handle company_id field
          if (record.company_id) {
            recordObj.company_id =
              record.company_id.company_name || "No Company";
          } else {
            recordObj.company_id = "No Company";
          }

          return recordObj;
        });

        return recordsWithPopulatedFields;
      },
      // Preload select options so the form shows fresh Company/User choices every visit.
      beforeCreateForm: async (req, res) => {
        try {
          const companies = await Company.find({
            status: "active",
            deletedAt: null,
          })
            .select("company_name")
            .sort({ company_name: 1 });
          req.fieldConfig.company_id.options = companies.map((company) => ({
            value: company._id.toString(),
            label: company.company_name,
          }));
          const users = await User.find({ deletedAt: null }, "name email").sort(
            { name: 1 },
          );
          req.fieldConfig.created_by.options = users.map((user) => ({
            value: user._id.toString(),
            label: user.name,
          }));
          req.fieldConfig.created_by.placeholder = "Select User";
          req.fieldConfig.created_by.helpText =
            "Choose the user who created this integration";
        } catch (error) {
          console.error("❌ Error in beforeCreateForm for user:", error);
        }
      },
      // Keep the company list in sync when editing existing users.
      beforeEditForm: async (req, res) => {
        const companies = await Company.find({
          status: "active",
          deletedAt: null,
        })
          .select("company_name")
          .sort({ company_name: 1 });
        req.fieldConfig.company_id.options = companies.map((company) => ({
          value: company._id.toString(),
          label: company.company_name,
        }));
      },
    },
    // Custom response formatting to show user name
    responseFormatting: {
      list: async (records) =>
        records.map((record) => {
          const recordObj = record.toObject ? record.toObject() : record;
          if (recordObj.company_id?.name) {
            recordObj.user_name = recordObj.company_id.name;
            recordObj.user_email = recordObj.company_id.email;
          }
          return recordObj;
        }),
      editForm: async (record) => {
        if (
          record.permissions &&
          typeof record.permissions.toObject === "function"
        ) {
          record.permissions = record.permissions.toObject();
        }
        return record;
      },
    },
    fieldProcessing: {
      beforeInsert: async (data) => {
        if (
          data.permissions &&
          typeof data.permissions.toObject === "function"
        ) {
          data.permissions = data.permissions.toObject();
        }
        return data;
      },
      beforeUpdate: async (data) => {
        if (
          data.permissions &&
          typeof data.permissions.toObject === "function"
        ) {
          data.permissions = data.permissions.toObject();
        }
        return data;
      },
    },
  },
);

/**
 * Auto-generate Admin CRUD with UI Forms for Blog model
 */
const companyAdminCRUD = adminCrudGenerator(
  Company,
  "company",
  [
    "company_name",
    "company_phone",
    "company_email",
    "company_address",
    "company_logo",
    "default_cash_account",
    "default_sales_account",
    "default_purchase_account",
    "default_sales_discount_account",
    "default_purchase_discount_account",
    "default_account_receivable_account",
    "default_account_payable_account",
    "default_shipping_account",
    "warehouse_id",
    "status",
  ], // Headings.
  {
    excludedFields: ["__v"],
    includedFields: [
      "company_name",
      "company_phone",
      "company_email",
      "company_address",
      "company_logo",
      "default_cash_account",
      "default_sales_account",
      "default_purchase_account",
      "default_sales_discount_account",
      "default_purchase_discount_account",
      "default_account_receivable_account",
      "default_account_payable_account",
      "default_shipping_account",
      "warehouse_id",
    ],
    searchableFields: ["company_name", "company_email", "company_phone"],
    filterableFields: ["status"],
    sortableFields: ["company_name", "company_email", "status", "createdAt"],
    baseUrl: BASE_URL,
    softDelete: true, // Enable soft delete functionality
    fieldTypes: {
      company_logo: "file",
      status: "select",
      deletedAt: "hidden",
      warehouse_id: "select",
      default_cash_account: "select",
      default_sales_account: "select",
      default_purchase_account: "select",
      default_sales_discount_account: "select",
      default_purchase_discount_account: "select",
      default_account_receivable_account: "select",
      default_account_payable_account: "select",
      default_shipping_account: "select",
    },
    fieldLabels: {
      company_logo: "Logo Image",
      company_name: "Company Name",
      company_phone: "Phone",
      company_email: "Email",
      company_address: "Address",
      warehouse_id: "Default Store",
      default_cash_account: "Default Cash Account",
      default_sales_account: "Default Sales Account",
      default_purchase_account: "Default Purchase Account",
      default_sales_discount_account: "Default Sales Discount Account",
      default_purchase_discount_account: "Default Purchase Discount Account",
      default_account_receivable_account: "Default Account Receivable Account",
      default_account_payable_account: "Default Account Payable Account",
      default_shipping_account: "Default Shipping Account",
    },
    fieldOptions: {
      status: [
        { value: "active", label: "Active" },
        { value: "inactive", label: "Inactive" },
      ],
    },
    middleware: {
      afterQuery: async (records, req) => {
        // Populate warehouse_id for all records that have it
        const populatedRecords = await Warehouse.populate(records, [
          {
            path: "warehouse_id",
            select: "warehouse_name",
          },
          { path: "company_id", select: "company_name" },
          { path: "created_by", select: "name email" },
        ]);

        // Add warehouse_id field to fieldConfig so it shows in the list view
        // BUT don't overwrite options if they were already set (e.g., in beforeEditForm)
        if (req.fieldConfig) {
          // Only set/update if it doesn't exist or if options weren't already populated
          if (
            !req.fieldConfig.warehouse_id ||
            !req.fieldConfig.warehouse_id.options ||
            req.fieldConfig.warehouse_id.options.length === 0
          ) {
            req.fieldConfig.warehouse_id = {
              name: "warehouse_id",
              type: "select",
              label: "Warehouse",
              required: false,
              validation: {},
              options: [],
              placeholder: "Warehouse",
              helpText: "Warehouse",
            };
          }
        }

        const recordsWithPopulatedFields = populatedRecords.map((record) => {
          const recordObj = record.toObject ? record.toObject() : record;

          // Handle created_by field
          if (record.created_by) {
            recordObj.created_by = record.created_by.name || "No User";
          } else {
            recordObj.created_by = "No User";
          }

          // Handle company_id field
          if (record.company_id) {
            recordObj.company_id =
              record.company_id.company_name || "No Company";
          } else {
            recordObj.company_id = "No Company";
          }

          // Handle warehouse_id field
          if (record.warehouse_id) {
            recordObj.warehouse_id =
              record.warehouse_id.warehouse_name || "No Warehouse";
          } else {
            recordObj.warehouse_id = "No Warehouse";
          }
          return recordObj;
        });

        return recordsWithPopulatedFields;

        // console.log('afterquery called.')

        // Note: Dropdown options are set in beforeCreateForm/beforeEditForm middleware
        // This afterQuery middleware is only for populating existing records in list views

        // return populatedRecords; // Return populated records with company data
      },
      beforeCreateForm: async (req, res) => {
        try {
          const accountFields = [
            "default_cash_account",
            "default_sales_account",
            "default_purchase_account",
            "default_sales_discount_account",
            "default_purchase_discount_account",
            "default_account_receivable_account",
            "default_account_payable_account",
            "default_shipping_account",
          ];
          console.log(
            "🔍 beforeCreateForm - req.fieldConfig exists:",
            !!req.fieldConfig,
          );
          console.log(
            "🔍 beforeCreateForm - fieldConfig keys:",
            req.fieldConfig ? Object.keys(req.fieldConfig) : "N/A",
          );
          console.log(
            "🔍 beforeCreateForm - warehouse_id in fieldConfig:",
            req.fieldConfig ? !!req.fieldConfig.warehouse_id : "N/A",
          );

          const warehouses = await Warehouse.find({
            status: "active",
            $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }],
          })
            .select("warehouse_name warehouse_address")
            .sort({ warehouse_name: 1 });

          console.log(
            "🔍 beforeCreateForm - warehouses found:",
            warehouses.length,
          );
          console.log(
            "🔍 beforeCreateForm - warehouse data:",
            warehouses.map((w) => ({
              id: w._id.toString(),
              name: w.warehouse_name,
            })),
          );

          // Ensure warehouse_id field exists in fieldConfig
          if (!req.fieldConfig.warehouse_id) {
            console.log("⚠️ warehouse_id not in fieldConfig, creating it...");
            req.fieldConfig.warehouse_id = {
              name: "warehouse_id",
              type: "select",
              label: "Default Store",
              required: false,
              validation: {},
              options: [],
              placeholder: "Select Warehouse",
              helpText: "Choose the warehouse for this company",
            };
          }

          req.fieldConfig.warehouse_id.options = warehouses.map(
            (warehouse) => ({
              value: warehouse._id.toString(),
              label: warehouse.warehouse_name,
            }),
          );
          req.fieldConfig.warehouse_id.placeholder = "Select Warehouse";
          req.fieldConfig.warehouse_id.helpText =
            "Choose the warehouse for this company";
          req.warehouses = warehouses;

          // Populate account dropdown options for all default account fields.
          const accountFilter = {
            status: "active",
            $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }],
          };
          if (req.user?.company_id) {
            accountFilter.company_id = req.user.company_id;
          }
          const accounts = await Account.find(accountFilter)
            .select("name account_name account_number company_id")
            .populate({ path: "company_id", select: "company_name" })
            .sort({ name: 1 });
          const accountOptions = accounts.map((account) => ({
            value: account._id.toString(),
            label: (() => {
              const accountName =
                account.name || account.account_name || "Unnamed Account";
              const companyName =
                account.company_id?.company_name || "No Company";
              return `${accountName} (${companyName})`;
            })(),
          }));
          accountFields.forEach((fieldName) => {
            if (!req.fieldConfig[fieldName]) return;
            req.fieldConfig[fieldName].type = "select";
            req.fieldConfig[fieldName].options = accountOptions;
            req.fieldConfig[fieldName].placeholder = `Select ${req.fieldConfig[fieldName].label}`;
          });

          console.log(
            "✅ beforeCreateForm - warehouse_id options set:",
            req.fieldConfig.warehouse_id.options.length,
          );
          console.log(
            "✅ beforeCreateForm - final warehouse_id config:",
            JSON.stringify(req.fieldConfig.warehouse_id, null, 2),
          );
        } catch (error) {
          console.error("❌ Error in beforeCreateForm for company:", error);
          // Ensure fieldConfig.warehouse_id exists even on error
          if (!req.fieldConfig.warehouse_id) {
            req.fieldConfig.warehouse_id = {
              name: "warehouse_id",
              type: "select",
              label: "Default Store",
              required: false,
              validation: {},
              options: [],
              placeholder: "Select Warehouse",
              helpText: "Choose the warehouse for this company",
            };
          }
        }
      },
      beforeEditForm: async (req, res) => {
        try {
          const accountFields = [
            "default_cash_account",
            "default_sales_account",
            "default_purchase_account",
            "default_sales_discount_account",
            "default_purchase_discount_account",
            "default_account_receivable_account",
            "default_account_payable_account",
            "default_shipping_account",
          ];
          console.log("🔍 beforeEditForm called for company");
          console.log(
            "🔍 beforeEditForm - req.fieldConfig exists:",
            !!req.fieldConfig,
          );
          console.log(
            "🔍 beforeEditForm - fieldConfig keys:",
            req.fieldConfig ? Object.keys(req.fieldConfig) : "N/A",
          );

          const warehouses = await Warehouse.find({
            status: "active",
            $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }],
          })
            .select("warehouse_name warehouse_address")
            .sort({ warehouse_name: 1 });

          console.log(
            "🔍 beforeEditForm - warehouses found:",
            warehouses.length,
          );
          console.log(
            "🔍 beforeEditForm - warehouse data:",
            warehouses.map((w) => ({
              id: w._id.toString(),
              name: w.warehouse_name,
            })),
          );

          // Ensure warehouse_id field exists in fieldConfig
          if (!req.fieldConfig.warehouse_id) {
            console.log("⚠️ warehouse_id not in fieldConfig, creating it...");
            req.fieldConfig.warehouse_id = {
              name: "warehouse_id",
              type: "select",
              label: "Default Store",
              required: false,
              validation: {},
              options: [],
              placeholder: "Select Warehouse",
              helpText: "Choose the warehouse for this company",
            };
          }

          req.warehouses = warehouses;
          req.fieldConfig.warehouse_id.options = warehouses.map(
            (warehouse) => ({
              value: warehouse._id.toString(),
              label: warehouse.warehouse_name,
            }),
          );
          req.fieldConfig.warehouse_id.placeholder = "Select Warehouse";
          req.fieldConfig.warehouse_id.helpText =
            "Choose the warehouse for this company";

          const accountFilter = {
            status: "active",
            $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }],
          };
          if (req.user?.company_id) {
            accountFilter.company_id = req.user.company_id;
          }
          const accounts = await Account.find(accountFilter)
            .select("name account_name account_number company_id")
            .populate({ path: "company_id", select: "company_name" })
            .sort({ name: 1 });
          const accountOptions = accounts.map((account) => ({
            value: account._id.toString(),
            label: (() => {
              const accountName =
                account.name || account.account_name || "Unnamed Account";
              const companyName =
                account.company_id?.company_name || "No Company";
              return `${accountName} (${companyName})`;
            })(),
          }));
          accountFields.forEach((fieldName) => {
            if (!req.fieldConfig[fieldName]) return;
            req.fieldConfig[fieldName].type = "select";
            req.fieldConfig[fieldName].options = accountOptions;
            req.fieldConfig[fieldName].placeholder = `Select ${req.fieldConfig[fieldName].label}`;
          });

          console.log(
            "✅ beforeEditForm - warehouse_id options set:",
            req.fieldConfig.warehouse_id.options.length,
          );
          console.log(
            "✅ beforeEditForm - final warehouse_id config:",
            JSON.stringify(req.fieldConfig.warehouse_id, null, 2),
          );
        } catch (error) {
          console.error("❌ Error in beforeEditForm for company:", error);
          // Ensure fieldConfig.warehouse_id exists even on error
          if (!req.fieldConfig.warehouse_id) {
            req.fieldConfig.warehouse_id = {
              name: "warehouse_id",
              type: "select",
              label: "Default Store",
              required: false,
              validation: {},
              options: [],
              placeholder: "Select Warehouse",
              helpText: "Choose the warehouse for this company",
            };
          }
        }
      },
    },
  },
);

const branchAdminCRUD = adminCrudGenerator(
  Branch,
  "branch",
  ["name", "phone", "email", "address", "company_id", "image", "status"], // Headings.
  {
    excludedFields: ["__v"],
    includedFields: [
      "name",
      "phone",
      "email",
      "address",
      "company_id",
      "image",
      "status",
    ],
    searchableFields: ["name", "email", "phone"],
    filterableFields: ["status"],
    sortableFields: ["name", "email", "status", "createdAt"],
    baseUrl: BASE_URL,
    softDelete: true, // Enable soft delete functionality
    fieldTypes: {
      image: "file",
      status: "select",
      deletedAt: "hidden",
      company_id: "select",
    },
    fieldLabels: {
      image: "Logo",
      name: "Branch Name",
      phone: "Phone",
      email: "Email",
      address: "Address",
      // warehouse_id: "Default Store",
    },
    fieldOptions: {
      status: [
        { value: "active", label: "Active" },
        { value: "inactive", label: "Inactive" },
      ],
    },
    fieldProcessing: {
      beforeInsert: async (data, req) => {
        if (!data.user_id && req.user?._id) {
          data.user_id = req.user._id;
        }
        return data;
      },
    },
    middleware: {
      afterQuery: async (records) => {
        const populatedRecords = await Branch.populate(records, [
          { path: "company_id", select: "company_name" },
          { path: "created_by", select: "name email" },
        ]);

        return populatedRecords.map((record) => {
          const recordObj = record.toObject ? record.toObject() : record;
          recordObj.created_by =
            record.created_by?.name || record.created_by?.email || "No User";
          recordObj.company_id =
            record.company_id?.company_name || "No Company";
          return recordObj;
        });
      },
      beforeCreateForm: async (req, res) => {
        try {
          const companies = await Company.find({
            status: "active",
            deletedAt: null,
          })
            .select("company_name")
            .sort({ company_name: 1 });

          req.fieldConfig.company_id.options = companies.map((company) => ({
            value: company._id.toString(),
            label: company.company_name,
          }));
          req.fieldConfig.company_id.placeholder = "Select Company";
          req.fieldConfig.company_id.helpText =
            "Choose the company for this branch";
        } catch (error) {
          console.error("❌ Error in beforeCreateForm for branch:", error);
        }
      },
      beforeEditForm: async (req, res) => {
        try {
          const companies = await Company.find({
            status: "active",
            deletedAt: null,
          })
            .select("company_name")
            .sort({ company_name: 1 });

          req.fieldConfig.company_id.options = companies.map((company) => ({
            value: company._id.toString(),
            label: company.company_name,
          }));
          req.fieldConfig.company_id.placeholder = "Select Company";
          req.fieldConfig.company_id.helpText =
            "Choose the company for this branch";
        } catch (error) {
          console.error("❌ Error in beforeEditForm for branch:", error);
        }
      },
    },
  },
);

/**
 * Auto-generate Admin CRUD with UI Forms for Account model
 */
const accountAdminCRUD = adminCrudGenerator(
  Account,
  "account",
  [
    "name",
    "account_number",
    "initial_balance",
    "description",
    "account_type",
    "company_id",
  ], // Headings.
  {
    excludedFields: ["__v"],
    includedFields: [
      "name",
      "account_number",
      "initial_balance",
      "description",
      "account_type",
      "company_id",
      "status",
    ],
    searchableFields: [
      "name",
      "account_number",
      "description",
      "account_type",
      "status",
    ],
    filterableFields: ["status"],
    sortableFields: [
      "name",
      "account_number",
      "description",
      "account_type",
      "createdAt",
    ],
    baseUrl: BASE_URL,
    softDelete: true, // Enable soft delete functionality
    fieldTypes: {
      status: "select",
      deletedAt: "hidden",
      company_id: "select",
    },
    fieldLabels: {
      // image: "Logo",
      name: "Name",
      // phone: "Phone",
      // email: "Email",
      // address: "Address",
      // warehouse_id: "Default Store",
    },
    fieldOptions: {
      status: [
        { value: "active", label: "Active" },
        { value: "inactive", label: "Inactive" },
      ],
    },
    fieldProcessing: {
      beforeInsert: async (data, req) => {
        if (!data.user_id && req.user?._id) {
          data.user_id = req.user._id;
        }
        return data;
      },
    },
    middleware: {
      afterQuery: async (records) => {
        const populatedRecords = await Branch.populate(records, [
          { path: "company_id", select: "company_name" },
          { path: "created_by", select: "name email" },
        ]);

        return populatedRecords.map((record) => {
          const recordObj = record.toObject ? record.toObject() : record;
          recordObj.created_by =
            record.created_by?.name || record.created_by?.email || "No User";
          recordObj.company_id =
            record.company_id?.company_name || "No Company";
          return recordObj;
        });
      },
      beforeCreateForm: async (req, res) => {
        try {
          const companies = await Company.find({
            status: "active",
            deletedAt: null,
          })
            .select("company_name")
            .sort({ company_name: 1 });

          req.fieldConfig.company_id.options = companies.map((company) => ({
            value: company._id.toString(),
            label: company.company_name,
          }));
          req.fieldConfig.company_id.placeholder = "Select Company";
          req.fieldConfig.company_id.helpText =
            "Choose the company for this branch";
        } catch (error) {
          console.error("❌ Error in beforeCreateForm for branch:", error);
        }
      },
      beforeEditForm: async (req, res) => {
        try {
          const companies = await Company.find({
            status: "active",
            deletedAt: null,
          })
            .select("company_name")
            .sort({ company_name: 1 });

          req.fieldConfig.company_id.options = companies.map((company) => ({
            value: company._id.toString(),
            label: company.company_name,
          }));
          req.fieldConfig.company_id.placeholder = "Select Company";
          req.fieldConfig.company_id.helpText =
            "Choose the company for this branch";
        } catch (error) {
          console.error("❌ Error in beforeEditForm for branch:", error);
        }
      },
    },
  },
);

/**
 * Auto-generate Admin CRUD with UI Forms for Blog model
 */
const blogAdminCRUD = adminCrudGenerator(
  Blog,
  "blogs",
  ["name", "description", "user_id", "image"], // Headings.
  {
    excludedFields: ["__v"],
    includedFields: ["name", "description", "user_id", "image", "createdAt"],
    searchableFields: ["name", "description"],
    filterableFields: ["user_id"],
    sortableFields: ["name", "description", "user_id", "createdAt"],
    baseUrl: BASE_URL,
    softDelete: true, // Enable soft delete functionality
    fieldTypes: {
      description: "textarea",
      image: "file",
      user_id: "select",
    },
    fieldLabels: {
      image: "Blog Image",
      user_id: "Posted User",
    },
    fieldOptions: {
      user_id: [], // Will be populated dynamically
    },
    middleware: {
      afterQuery: async (records, req) => {
        const populatedRecords = await Blog.populate(records, {
          path: "user_id",
          select: "name email",
        });

        if (req.fieldConfig?.user_id) {
          const users = await User.find(
            { deletedAt: { $exists: false } },
            "name email",
          ).sort({ name: 1 });
          req.fieldConfig.user_id.options = users.map((user) => ({
            value: user._id.toString(),
            label: user.name,
          }));
          req.fieldConfig.user_id.placeholder = "Select User";
          req.fieldConfig.user_id.helpText =
            "Choose the user who posted this blog";
        }

        return populatedRecords;
      },
    },
    // Custom response formatting to show user name
    responseFormatting: {
      list: async (records) =>
        records.map((record) => {
          const recordObj = record.toObject ? record.toObject() : record;
          if (recordObj.user_id?.name) {
            recordObj.user_name = recordObj.user_id.name;
            recordObj.user_email = recordObj.user_id.email;
          }
          return recordObj;
        }),
    },
  },
);

const attributeAdminCRUD = adminCrudGenerator(
  Attribute,
  "attribute",
  ["name", "description", "attribute_values", "user_id"],
  {
    excludedFields: ["__v"],
    includedFields: [
      "name",
      "description",
      "attribute_values",
      "user_id",
      "createdAt",
    ],
    searchableFields: ["name", "description"],
    filterableFields: ["user_id"],
    sortableFields: ["name", "description", "user_id", "createdAt"],
    baseUrl: BASE_URL,
    softDelete: true, // Enable soft delete functionality
    fieldTypes: {
      description: "textarea",
      user_id: "select",
      attribute_values: "custom", // Custom field type for attribute values
    },
    fieldLabels: {
      description: "Description",
      user_id: "User",
      attribute_values: "Attribute Values",
    },
    fieldOptions: {
      user_id: [], // Will be populated dynamically
    },
    middleware: {
      afterQuery: async (records, req) => {
        const populatedRecords = await Attribute.populate(records, {
          path: "user_id",
          select: "name",
        });
        if (req.fieldConfig?.user_id) {
          const users = await User.find(
            { deletedAt: { $exists: false } },
            "name",
          ).sort({ name: 1 });
          req.fieldConfig.user_id.options = users.map((user) => ({
            value: user._id.toString(),
            label: user.name,
          }));
        }
        return populatedRecords;
      },
    },
    // Custom response formatting to ensure attribute_values are properly converted
    responseFormatting: {
      editForm: async (recordData) => {
        // Ensure attribute_values are properly converted to plain objects
        if (
          recordData.attribute_values &&
          Array.isArray(recordData.attribute_values)
        ) {
          recordData.attribute_values = recordData.attribute_values.map(
            (item) => {
              if (item && typeof item === "object") {
                // Convert Mongoose subdocument to plain object if needed
                if (item.toObject && typeof item.toObject === "function") {
                  return item.toObject();
                }
                // Already a plain object, but ensure it has the expected structure
                return {
                  name: item.name || "",
                  last_updated: item.last_updated || new Date(),
                  _id: item._id || undefined,
                };
              }
              return item;
            },
          );
        }
        return recordData;
      },
    },
    fieldProcessing: {
      // Process attribute_values before insert
      beforeInsert: async (data, req) => {
        console.log("🔍 beforeInsert - Processing attribute_values");
        console.log("🔍 beforeInsert - req.body keys:", Object.keys(req.body));
        console.log(
          "🔍 beforeInsert - req.body.attribute_values:",
          req.body.attribute_values,
        );

        const attributeValues = [];

        // FIRST: Check for attribute_values fields with indexed format (e.g., attribute_values[0][name])
        // This is the most common format from HTML forms
        const attributeFields = Object.keys(req.body).filter((key) =>
          key.includes("attribute_values"),
        );

        console.log(
          "🔍 beforeInsert - Found attribute_fields:",
          attributeFields,
        );

        if (attributeFields.length > 0) {
          const valuesData = {};

          // Parse the attribute_values data from the field names
          attributeFields.forEach((field) => {
            const match = field.match(/attribute_values\[(\d+)\]\[(\w+)\]/);
            if (match) {
              const [, index, property] = match;
              if (!valuesData[index]) {
                valuesData[index] = {};
              }
              const value = req.body[field];
              console.log(
                `🔍 beforeInsert - Processing field ${field}:`,
                value,
              );
              // Only store non-empty values
              if (value !== undefined && value !== null && value !== "") {
                valuesData[index][property] = value;
              }
            }
          });

          console.log("🔍 beforeInsert - Parsed valuesData:", valuesData);

          // Convert to array format, filtering out empty items
          Object.keys(valuesData).forEach((key) => {
            const item = valuesData[key];
            // Only add if name exists and is not empty after trimming
            if (
              item &&
              item.name &&
              typeof item.name === "string" &&
              item.name.trim() !== ""
            ) {
              attributeValues.push({
                name: item.name.trim(),
                last_updated: new Date(),
              });
            }
          });
        }

        // SECOND: Parse attribute_values from request (if sent as object/array)
        if (req.body.attribute_values && attributeValues.length === 0) {
          const valuesData = req.body.attribute_values;

          // Handle object format from form (e.g., attribute_values[0][name])
          if (typeof valuesData === "object" && !Array.isArray(valuesData)) {
            // Convert object format to array
            Object.keys(valuesData).forEach((key) => {
              const item = valuesData[key];
              // Only add if name exists and is not empty after trimming
              if (
                item &&
                item.name &&
                typeof item.name === "string" &&
                item.name.trim() !== ""
              ) {
                attributeValues.push({
                  name: item.name.trim(),
                  last_updated: new Date(),
                });
              }
            });
          } else if (Array.isArray(valuesData)) {
            valuesData.forEach((item) => {
              // Only add if name exists and is not empty after trimming
              if (
                item &&
                item.name &&
                typeof item.name === "string" &&
                item.name.trim() !== ""
              ) {
                attributeValues.push({
                  name: item.name.trim(),
                  last_updated: new Date(),
                });
              }
            });
          }
        }

        console.log(
          "🔍 beforeInsert - Final attributeValues:",
          attributeValues,
        );

        // Always set attribute_values, even if empty array
        data.attribute_values = attributeValues;

        // Remove any indexed attribute_values fields from data to prevent duplicates
        Object.keys(data).forEach((key) => {
          if (
            key.includes("attribute_values") &&
            key.match(/attribute_values\[(\d+)\]\[(\w+)\]/)
          ) {
            delete data[key];
          }
        });

        console.log(
          "🔍 beforeInsert - Final data.attribute_values:",
          data.attribute_values,
        );

        return data;
      },
      // Process attribute_values before update
      beforeUpdate: async (data, req, record) => {
        console.log("🔍 beforeUpdate - Processing attribute_values");
        console.log("🔍 beforeUpdate - req.body keys:", Object.keys(req.body));
        console.log(
          "🔍 beforeUpdate - req.body.attribute_values:",
          JSON.stringify(req.body.attribute_values, null, 2),
        );
        console.log(
          "🔍 beforeUpdate - existing record attribute_values:",
          record?.attribute_values,
        );
        console.log(
          "🔍 beforeUpdate - data.attribute_values:",
          data.attribute_values,
        );

        const attributeValues = [];

        // FIRST: Check for attribute_values fields with indexed format (e.g., attribute_values[0][name])
        // Express urlencoded({ extended: true }) parses these into nested objects
        const attributeFields = Object.keys(req.body).filter(
          (key) =>
            key.includes("attribute_values") && key !== "attribute_values",
        );

        console.log(
          "🔍 beforeUpdate - Found attribute_fields (excluding 'attribute_values' key):",
          attributeFields,
        );

        // Process indexed fields if they exist (raw form data before parsing)
        if (attributeFields.length > 0) {
          const valuesData = {};

          attributeFields.forEach((field) => {
            const match = field.match(/attribute_values\[(\d+)\]\[(\w+)\]/);
            if (match) {
              const [, index, property] = match;
              if (!valuesData[index]) {
                valuesData[index] = {};
              }
              const value = req.body[field];
              console.log(
                `🔍 beforeUpdate - Processing field ${field}:`,
                value,
              );
              if (value !== undefined && value !== null && value !== "") {
                valuesData[index][property] = value;
              }
            }
          });

          console.log(
            "🔍 beforeUpdate - Parsed valuesData from indexed fields:",
            valuesData,
          );

          Object.keys(valuesData).forEach((key) => {
            const item = valuesData[key];
            if (
              item &&
              item.name &&
              typeof item.name === "string" &&
              item.name.trim() !== ""
            ) {
              attributeValues.push({
                name: item.name.trim(),
                last_updated: new Date(),
              });
            }
          });
        }

        // SECOND: Process req.body.attribute_values (parsed by Express)
        // This handles cases where body parser has already parsed indexed format into nested object
        if (
          req.body.attribute_values !== undefined &&
          attributeValues.length === 0
        ) {
          const valuesData = req.body.attribute_values;
          console.log(
            "🔍 beforeUpdate - Processing req.body.attribute_values:",
            JSON.stringify(valuesData, null, 2),
          );

          // Handle object format from form (e.g., attribute_values[0][name] parsed as { 0: { name: 'value' } })
          if (
            typeof valuesData === "object" &&
            valuesData !== null &&
            !Array.isArray(valuesData)
          ) {
            const keys = Object.keys(valuesData);
            const hasNumericKeys = keys.some((key) => /^\d+$/.test(key));

            if (hasNumericKeys) {
              // Convert object with numeric keys to array (parsed from indexed format)
              const sortedKeys = keys.sort((a, b) => parseInt(a) - parseInt(b));
              console.log(
                "🔍 beforeUpdate - Found numeric keys, converting to array:",
                sortedKeys,
              );
              sortedKeys.forEach((key) => {
                const item = valuesData[key];
                console.log(
                  `🔍 beforeUpdate - Processing item at index ${key}:`,
                  item,
                );
                if (
                  item &&
                  item.name &&
                  typeof item.name === "string" &&
                  item.name.trim() !== ""
                ) {
                  attributeValues.push({
                    name: item.name.trim(),
                    last_updated: new Date(),
                  });
                }
              });
            } else {
              // Regular object format (shouldn't happen with our form, but handle it)
              Object.keys(valuesData).forEach((key) => {
                const item = valuesData[key];
                if (
                  item &&
                  item.name &&
                  typeof item.name === "string" &&
                  item.name.trim() !== ""
                ) {
                  attributeValues.push({
                    name: item.name.trim(),
                    last_updated: new Date(),
                  });
                }
              });
            }
          } else if (Array.isArray(valuesData)) {
            // Already an array
            valuesData.forEach((item) => {
              if (
                item &&
                item.name &&
                typeof item.name === "string" &&
                item.name.trim() !== ""
              ) {
                attributeValues.push({
                  name: item.name.trim(),
                  last_updated: new Date(),
                });
              }
            });
          }
        }

        // Also check data.attribute_values in case it was already processed
        if (
          data.attribute_values !== undefined &&
          attributeValues.length === 0
        ) {
          console.log(
            "🔍 beforeUpdate - Checking data.attribute_values:",
            data.attribute_values,
          );
          const valuesData = data.attribute_values;

          if (
            typeof valuesData === "object" &&
            valuesData !== null &&
            !Array.isArray(valuesData)
          ) {
            const keys = Object.keys(valuesData);
            const hasNumericKeys = keys.some((key) => /^\d+$/.test(key));

            if (hasNumericKeys) {
              const sortedKeys = keys.sort((a, b) => parseInt(a) - parseInt(b));
              sortedKeys.forEach((key) => {
                const item = valuesData[key];
                if (
                  item &&
                  item.name &&
                  typeof item.name === "string" &&
                  item.name.trim() !== ""
                ) {
                  attributeValues.push({
                    name: item.name.trim(),
                    last_updated: new Date(),
                  });
                }
              });
            }
          } else if (Array.isArray(valuesData)) {
            valuesData.forEach((item) => {
              if (
                item &&
                item.name &&
                typeof item.name === "string" &&
                item.name.trim() !== ""
              ) {
                attributeValues.push({
                  name: item.name.trim(),
                  last_updated: new Date(),
                });
              }
            });
          }
        }

        console.log(
          "🔍 beforeUpdate - Final attributeValues:",
          JSON.stringify(attributeValues, null, 2),
        );
        console.log(
          "🔍 beforeUpdate - Has form data:",
          attributeFields.length > 0 ||
            req.body.attribute_values !== undefined ||
            data.attribute_values !== undefined,
        );

        // Always update if we found any attribute_values data, or if explicitly set to empty array
        const hasFormData =
          attributeFields.length > 0 ||
          req.body.attribute_values !== undefined ||
          (data.attribute_values !== undefined &&
            Array.isArray(data.attribute_values) &&
            data.attribute_values.length === 0);

        if (hasFormData) {
          // Form data was provided - use it
          data.attribute_values = attributeValues;

          // Remove any indexed attribute_values fields from data to prevent duplicates
          Object.keys(data).forEach((key) => {
            if (
              key.includes("attribute_values") &&
              key.match(/attribute_values\[(\d+)\]\[(\w+)\]/)
            ) {
              delete data[key];
            }
          });
          // Also remove req.body.attribute_values from data if it was parsed as an object
          if (
            data.attribute_values &&
            typeof data.attribute_values === "object" &&
            !Array.isArray(data.attribute_values)
          ) {
            // This was the parsed object, we've already converted it, so remove it
            // But wait, we just set it above, so this should be fine
          }
        } else {
          // No form data for attribute_values - preserve existing values
          console.log(
            "🔍 beforeUpdate - No form data for attribute_values, preserving existing values",
          );
          if (record && record.attribute_values) {
            // Convert Mongoose subdocuments to plain objects if needed
            const existingValues =
              Array.isArray(record.attribute_values) ?
                record.attribute_values.map((item) => {
                  if (item && typeof item === "object" && item.toObject) {
                    return item.toObject();
                  }
                  return item;
                })
              : [];
            data.attribute_values = existingValues;
            console.log(
              "🔍 beforeUpdate - Preserved existing values:",
              JSON.stringify(data.attribute_values, null, 2),
            );
          }
        }

        console.log(
          "🔍 beforeUpdate - Final data.attribute_values:",
          JSON.stringify(data.attribute_values, null, 2),
        );

        return data;
      },
    },
  },
);

/**
 * Auto-generate Admin CRUD with UI Forms for Order model
 */
const orderAdminCRUD = adminCrudGenerator(
  Order,
  "orders",
  ["name", "email", "phone", "address", "description", "user_id"],
  {
    excludedFields: ["__v"],
    includedFields: [
      "name",
      "email",
      "phone",
      "address",
      "description",
      "user_id",
      "createdAt",
    ],
    searchableFields: ["name", "email", "phone", "address"],
    filterableFields: [],
    sortableFields: ["name", "email", "phone", "createdAt"],
    baseUrl: BASE_URL,
    softDelete: true, // Enable soft delete functionality
    fieldTypes: {
      description: "textarea",
      email: "email",
      phone: "number",
      user_id: "select",
    },
    middleware: {
      afterQuery: async (records, req) => {
        const populatedRecords = await Blog.populate(records, {
          path: "user_id",
          select: "name",
        });
        if (req.fieldConfig?.user_id) {
          const users = await User.find(
            { deletedAt: { $exists: false } },
            "name",
          ).sort({ name: 1 });
          req.fieldConfig.user_id.options = users.map((user) => ({
            value: user._id.toString(),
            label: user.name,
          }));
          req.fieldConfig.user_id.placeholder = "Select User";
          req.fieldConfig.user_id.helpText =
            "Choose the user who posted this blog";
        }
        return populatedRecords;
      },
    },
    responseFormatting: {
      list: async (records) =>
        records.map((record) => {
          const recordObj = record.toObject ? record.toObject() : record;
          if (recordObj.user_id?.name) {
            recordObj.user_name = recordObj.user_id.name;
            recordObj.user_email = recordObj.user_id.email;
          }
          return recordObj;
        }),
    },
  },
);
/**
 * Auto-generate Admin CRUD with UI Forms for Product model
 */
const productAdminCRUD = adminCrudGenerator(
  Product, // Mongoose model for products
  "products", // Route prefix for product CRUD operations
  [
    "parent_product_id",
    "brand_id",
    "product_name",
    "product_slug",
    "category_id",
    "product_description",
    "warehouse_inventory",
    "warehouse_inventory_display",
    "total_quantity",
    "product_price",
    "product_image",
    "multi_images",
    "product_type",
    "unit",
    "weight",
    "length",
    "width",
    "height",
    "dimension",
    "tax_rate",
    "barcode",
  ], // Fields to include in CRUD operations
  {
    excludedFields: ["__v"], // Fields to exclude from forms and display
    includedFields: [], // Additional fields to include (empty means use all except excluded)
    searchableFields: [
      "product_name",
      "brand_id",
      "product_description",
      "product_price",
      "product_type",
      "unit",
      "weight",
      "length",
      "width",
      "height",
      "dimension",
      "tax_rate",
      "barcode",
    ], // Fields that can be searched (excluded parent_product_id as it's ObjectId)
    filterableFields: [], // Fields that can be filtered (empty means filter by all displayed fields)
    sortableFields: [
      "product_name",
      "brand_id",
      "price",
      "description",
      "description_details",
      "createdAt",
      "product_type",
      "unit",
      "weight",
      "length",
      "width",
      "height",
      "dimension",
      "tax_rate",
      "barcode",
    ], // Fields that can be sorted
    baseUrl: BASE_URL, // Base URL for the application
    softDelete: true, // Enable soft delete functionality
    fieldTypes: {
      price: "number", // Number input field
      product_image: "file", // File upload field for single image
      description: "textarea", // Multi-line text area
      multi_images: "file", // File upload field for multiple images
      warehouse_inventory: "custom", // Custom field type for warehouse inventory
      warehouse_inventory_display: "text", // Display only field
      total_quantity: "number", // Display only field
      parent_product_id: "select", // Dropdown select field+
      category_id: "multiselect",
      brand_id: "select",
      product_type: "select", // Enum field for product type
      unit: "select", // Enum field for unit
    },
    fieldLabels: {
      product_image: "Product Image", // Human-readable label for product image
      multi_images: "Multiple Product Images", // Human-readable label for multiple images
      warehouse_inventory: "Warehouse Inventory", // Human-readable label for warehouse inventory
      warehouse_inventory_display: "Warehouse Inventory", // Human-readable label for warehouse inventory display
      total_quantity: "Total Quantity", // Human-readable label for total quantity
      product_price: "Product Price", // Human-readable label for product price
      product_type: "Product Type", // Human-readable label for product type
      unit: "Unit", // Human-readable label for unit
    },
    fieldOptions: {
      product_type: [
        { value: "Single", label: "Single" },
        { value: "Variable", label: "Variable" },
      ],
      unit: [
        { value: "Piece", label: "Piece" },
        { value: "Ltr", label: "Ltr" },
        { value: "Box", label: "Box" },
        { value: "Meter", label: "Meter" },
        { value: "Feet", label: "Feet" },
        { value: "Yard", label: "Yard" },
        { value: "Inch", label: "Inch" },
        { value: "Centimeter", label: "Centimeter" },
        { value: "Millimeter", label: "Millimeter" },
        { value: "Others", label: "Others" },
      ],
    },
    middleware: {
      afterQuery: async (records, req) => {
        // Filter out records with empty parent_product_id to avoid cast errors
        const validRecords = records.filter(
          (record) =>
            record.parent_product_id &&
            record.parent_product_id !== null &&
            record.parent_product_id !== "",
        );

        if (req.fieldConfig?.category_id) {
          const categories = await Category.find(
            { deletedAt: null },
            "name",
          ).sort({ name: 1 });
          req.fieldConfig.category_id.options = categories.map((category) => ({
            value: category._id.toString(),
            label: category.name,
          }));
          req.fieldConfig.category_id.placeholder = "Select Category";
          req.fieldConfig.category_id.helpText =
            "Choose the category for this product";
        }
        // console.log('req.fieldConfig', req.fieldConfig);
        if (req.fieldConfig?.brand_id) {
          const brands = await Brands.find({ deletedAt: null }, "name").sort({
            name: 1,
          });
          req.fieldConfig.brand_id.options = brands.map((brand) => ({
            value: brand._id.toString(),
            label: brand.name,
          }));
          req.fieldConfig.brand_id.placeholder = "Select Brand";
          req.fieldConfig.brand_id.helpText =
            "Choose the brand for this product";
        }
        // Only populate if there are valid records
        let populatedRecords = records;
        if (validRecords.length > 0) {
          populatedRecords = await Product.populate(records, [
            {
              path: "category_id",
              select: "name",
            },
            {
              path: "parent_product_id",
              select: "product_name",
            },
            {
              path: "warehouse_inventory.warehouse_id",
              select: "warehouse_name warehouse_address status",
            },
            {
              path: "brand_id",
              select: "name",
            },
          ]);
        }

        // Note: Dropdown options are set in beforeCreateForm/beforeEditForm middleware
        // This afterQuery middleware is only for populating existing records in list views

        // console.log('🔍 Populated records:', populatedRecords); // Debug log of populated records
        return populatedRecords; // Return populated records with both parent products and warehouse data
      },
      // Fetch warehouses before rendering create form
      beforeCreateForm: async (req, res) => {
        try {
          // Fetch all active products for parent_product_id dropdown
          // Use aggregate to avoid ObjectId casting issues with legacy data
          const categories = await Category.find({
            status: "active", // Only active companies
            deletedAt: null, // Only non-deleted companies
          })
            .select("name")
            .sort({ name: 1 }); // Select company details and sort by name
          console.log("categories___", categories);
          // Add companies to request object for view access
          req.categories = categories; // Store categories in request for form access
          req.fieldConfig.category_id.options = categories.map((category) => ({
            value: category._id.toString(),
            label: category.name,
          }));
          req.fieldConfig.category_id.placeholder = "Select Category";
          req.fieldConfig.category_id.helpText =
            "Choose the Category for this product";

          const brands = await Brands.find({ deletedAt: null }, "name").sort({
            name: 1,
          });
          req.fieldConfig.brand_id.options = brands.map((brand) => ({
            value: brand._id.toString(),
            label: brand.name,
          }));
          req.fieldConfig.brand_id.placeholder = "Select Brand";
          req.fieldConfig.brand_id.helpText =
            "Choose the brand for this product";

          // Use aggregation pipeline to filter parent products efficiently
          const parent_products = await Product.aggregate([
            {
              $match: {
                deletedAt: null, // Only non-deleted products
                $or: [
                  { parent_product_id: null }, // Products with null parent
                  { parent_product_id: { $exists: false } }, // Products without parent_product_id field
                  { parent_product_id: "" }, // Products with empty string parent (legacy data)
                  { parent_product_id: { $eq: "" } }, // Alternative empty string check
                ],
              },
            },
            {
              $project: {
                _id: 1,
                product_name: 1,
              },
            },
            {
              $sort: { product_name: 1 },
            },
          ]);

          console.log("✅ Parent product options set:", parent_products);
          console.log("🔍 Parent products count:", parent_products.length);
          console.log("🔍 Field config exists:", !!req.fieldConfig);
          console.log(
            "🔍 Parent product field exists:",
            !!req.fieldConfig?.parent_product_id,
          );

          // Add parent products to request object for view access
          if (req.fieldConfig?.parent_product_id) {
            // Check if field config exists
            req.fieldConfig.parent_product_id.options = parent_products.map(
              (product) => ({
                value: product._id.toString(),
                label: product.product_name,
              }),
            ); // Convert products to dropdown options
            req.fieldConfig.parent_product_id.placeholder =
              "Select Parent Product"; // Set dropdown placeholder
            req.fieldConfig.parent_product_id.helpText =
              "Choose the parent product for this product"; // Set dropdown help text
            console.log(
              "✅ Parent product options set:",
              req.fieldConfig.parent_product_id.options.length,
            ); // Log success with count
            console.log(
              "🔍 Options array:",
              req.fieldConfig.parent_product_id.options,
            ); // Log the actual options
          } else {
            console.log("❌ Parent product field config not found"); // Log error if config missing
            console.log(
              "🔍 Available field config keys:",
              Object.keys(req.fieldConfig || {}),
            ); // Log available fields
          }

          // Fetch all active warehouses
          const warehouses = await Warehouse.find({
            status: "active", // Only active warehouses
            deletedAt: null, // Only non-deleted warehouses
          })
            .select("warehouse_name warehouse_address")
            .sort({ warehouse_name: 1 }); // Select warehouse details and sort by name

          // Add warehouses to request object for view access
          req.warehouses = warehouses; // Store warehouses in request for form access
        } catch (error) {
          console.error("Error fetching data:", error); // Log any errors
          req.warehouses = []; // Set empty array on error
        }
      },
      // Fetch warehouses before rendering edit form
      beforeEditForm: async (req, res) => {
        try {
          const brands = await Brands.find({ deletedAt: null }, "name").sort({
            name: 1,
          });
          if (req.fieldConfig?.brand_id) {
            req.fieldConfig.brand_id.options = brands.map((brand) => ({
              value: brand._id.toString(),
              label: brand.name,
            }));
            req.fieldConfig.brand_id.placeholder = "Select Brand";
            req.fieldConfig.brand_id.helpText =
              "Choose the brand for this product";
          }

          // Fetch all active products for parent_product_id dropdown
          const parent_products = await Product.find({
            deletedAt: null, // Only non-deleted products
          })
            .select("parent_product_id product_name")
            .sort({ product_name: 1 }); // Select parent product ID and name, sort alphabetically

          // Add parent products to request object for view access
          req.fieldConfig.parent_product_id.options = parent_products.map(
            (product) => ({
              value: product._id.toString(),
              label: product.product_name,
            }),
          ); // Convert products to dropdown options
          req.fieldConfig.parent_product_id.placeholder =
            "Select Parent Product"; // Set dropdown placeholder text
          req.fieldConfig.parent_product_id.helpText =
            "Choose the parent product for this product"; // Set dropdown help text

          // Fetch all active warehouses
          const warehouses = await Warehouse.find({
            status: "active", // Only active warehouses
            deletedAt: null, // Only non-deleted warehouses
          })
            .select("warehouse_name warehouse_address")
            .sort({ warehouse_name: 1 }); // Select warehouse details and sort by name

          // Add warehouses to request object for view access
          req.warehouses = warehouses; // Store warehouses in request for form access
        } catch (error) {
          console.error("Error fetching data:", error); // Log any errors that occur
          req.warehouses = []; // Set empty array on error
        }
      },
      // Process warehouse inventory before insert
      beforeInsert: async (req, res) => {
        // Convert empty strings to null for ObjectId fields to prevent cast errors
        const objectIdFields = [
          "parent_product_id",
          "brand_id",
          "company_id",
          "created_by",
          "updated_by",
        ];

        objectIdFields.forEach((field) => {
          if (req.body[field] === "" || req.body[field] === undefined) {
            req.body[field] = null;
          }
        });

        // Parse warehouse_inventory from request
        if (req.body.warehouse_inventory) {
          const warehouseInventory = [];
          const inventoryData = req.body.warehouse_inventory;

          // Handle object format from form (e.g., warehouse_inventory[0][warehouse_id])
          if (
            typeof inventoryData === "object" &&
            !Array.isArray(inventoryData)
          ) {
            // Convert object format to array
            Object.keys(inventoryData).forEach((key) => {
              const item = inventoryData[key];
              if (item.warehouse_id && item.quantity !== undefined) {
                warehouseInventory.push({
                  warehouse_id: item.warehouse_id,
                  quantity: parseInt(item.quantity) || 0,
                  last_updated: new Date(),
                });
              }
            });
          } else if (Array.isArray(inventoryData)) {
            inventoryData.forEach((item) => {
              if (item.warehouse_id && item.quantity !== undefined) {
                warehouseInventory.push({
                  warehouse_id: item.warehouse_id,
                  quantity: parseInt(item.quantity) || 0,
                  last_updated: new Date(),
                });
              }
            });
          }

          // Update request body with processed inventory
          req.body.warehouse_inventory = warehouseInventory;
        } else {
          // Check for warehouse_inventory fields with different patterns
          const warehouseFields = Object.keys(req.body).filter((key) =>
            key.includes("warehouse_inventory"),
          );

          if (warehouseFields.length > 0) {
            const warehouseInventory = [];

            // Try to parse the warehouse_inventory data from the field names
            const inventoryData = {};
            warehouseFields.forEach((field) => {
              const match = field.match(
                /warehouse_inventory\[(\d+)\]\[(\w+)\]/,
              );
              if (match) {
                const [, index, property] = match;
                if (!inventoryData[index]) {
                  inventoryData[index] = {};
                }
                inventoryData[index][property] = req.body[field];
              }
            });

            // Convert to array format
            Object.keys(inventoryData).forEach((key) => {
              const item = inventoryData[key];
              if (item.warehouse_id && item.quantity !== undefined) {
                warehouseInventory.push({
                  warehouse_id: item.warehouse_id,
                  quantity: parseInt(item.quantity) || 0,
                  last_updated: new Date(),
                });
              }
            });

            req.body.warehouse_inventory = warehouseInventory;
          }
        }
      },
      // Process warehouse inventory before update
      beforeUpdate: async (req, res) => {
        console.log(
          "🔧 beforeUpdate middleware - Processing warehouse inventory",
        );
        console.log(
          "🔧 Original req.body.warehouse_inventory:",
          req.body.warehouse_inventory,
        );

        // Convert empty strings to null for ObjectId fields to prevent cast errors
        const objectIdFields = [
          "parent_product_id",
          "brand_id",
          "company_id",
          "created_by",
          "updated_by",
        ];

        objectIdFields.forEach((field) => {
          if (req.body[field] === "" || req.body[field] === undefined) {
            req.body[field] = null;
          }
        });

        // Parse warehouse_inventory from request
        if (req.body.warehouse_inventory) {
          const warehouseInventory = [];
          const inventoryData = req.body.warehouse_inventory;

          // Handle object format from form (e.g., warehouse_inventory[0][warehouse_id])
          if (
            typeof inventoryData === "object" &&
            !Array.isArray(inventoryData)
          ) {
            // Convert object format to array
            Object.keys(inventoryData).forEach((key) => {
              const item = inventoryData[key];
              if (item.warehouse_id && item.quantity !== undefined) {
                warehouseInventory.push({
                  warehouse_id: item.warehouse_id,
                  quantity: parseInt(item.quantity) || 0,
                  last_updated: new Date(),
                });
              }
            });
          } else if (Array.isArray(inventoryData)) {
            inventoryData.forEach((item) => {
              if (item.warehouse_id && item.quantity !== undefined) {
                warehouseInventory.push({
                  warehouse_id: item.warehouse_id,
                  quantity: parseInt(item.quantity) || 0,
                  last_updated: new Date(),
                });
              }
            });
          }

          // Update request body with processed inventory
          req.body.warehouse_inventory = warehouseInventory;
          console.log("✅ Processed warehouse inventory:", warehouseInventory);
        } else {
          // Check for warehouse_inventory fields with different patterns
          const warehouseFields = Object.keys(req.body).filter((key) =>
            key.includes("warehouse_inventory"),
          );

          if (warehouseFields.length > 0) {
            console.log("🔧 Found warehouse fields:", warehouseFields);
            const warehouseInventory = [];

            // Try to parse the warehouse_inventory data from the field names
            const inventoryData = {};
            warehouseFields.forEach((field) => {
              const match = field.match(
                /warehouse_inventory\[(\d+)\]\[(\w+)\]/,
              );
              if (match) {
                const [, index, property] = match;
                if (!inventoryData[index]) {
                  inventoryData[index] = {};
                }
                inventoryData[index][property] = req.body[field];
              }
            });

            // Convert to array format
            Object.keys(inventoryData).forEach((key) => {
              const item = inventoryData[key];
              if (item.warehouse_id && item.quantity !== undefined) {
                warehouseInventory.push({
                  warehouse_id: item.warehouse_id,
                  quantity: parseInt(item.quantity) || 0,
                  last_updated: new Date(),
                });
              }
            });

            req.body.warehouse_inventory = warehouseInventory;
            console.log(
              "✅ Processed warehouse inventory from field names:",
              warehouseInventory,
            );
          }
        }
      },
    },
    fieldProcessing: {
      beforeInsert: async (data, req) => {
        // Convert empty strings to null for ObjectId fields to prevent cast errors
        const objectIdFields = [
          "parent_product_id",
          "brand_id",
          "company_id",
          "created_by",
          "updated_by",
        ];

        objectIdFields.forEach((field) => {
          if (data[field] === "" || data[field] === undefined) {
            data[field] = null;
          }
        });

        return data;
      },
      beforeUpdate: async (data, req) => {
        // Convert empty strings to null for ObjectId fields to prevent cast errors
        const objectIdFields = [
          "parent_product_id",
          "brand_id",
          "company_id",
          "created_by",
          "updated_by",
        ];

        objectIdFields.forEach((field) => {
          if (data[field] === "" || data[field] === undefined) {
            data[field] = null;
          }
        });

        return data;
      },
    },
    // Custom response formatting to show warehouse inventory nicely
    responseFormatting: {
      list: async (records) =>
        records.map((record) => {
          const recordObj = record.toObject ? record.toObject() : record;

          // Format warehouse inventory for display
          if (
            recordObj.warehouse_inventory &&
            Array.isArray(recordObj.warehouse_inventory)
          ) {
            recordObj.warehouse_inventory_display =
              recordObj.warehouse_inventory
                .map((item) => {
                  const warehouse = item.warehouse_id;
                  if (warehouse && warehouse.warehouse_name) {
                    return `${warehouse.warehouse_name}: ${item.quantity}`;
                  }
                  return `Unknown Warehouse: ${item.quantity}`;
                })
                .join(", ");

            // Also add a summary
            const totalQuantity = recordObj.warehouse_inventory.reduce(
              (sum, item) => sum + (item.quantity || 0),
              0,
            );
            recordObj.total_quantity = totalQuantity;
          } else {
            recordObj.warehouse_inventory_display = "No inventory";
            recordObj.total_quantity = 0;
          }

          return recordObj;
        }),
    },
  },
);

/**
 * Auto-generate Admin CRUD with UI Forms for warehouse model
 */
const warehouseAdminCRUD = adminCrudGenerator(
  Warehouse, // Mongoose model for warehouse
  "warehouse", // Route prefix for warehouse CRUD operations
  [
    "warehouse_name",
    "warehouse_address",
    "company_id",
    "warehouse_image",
    "status",
  ], // Fields to include in CRUD operations
  {
    excludedFields: ["__v"], // Fields to exclude from forms and display
    includedFields: [
      "warehouse_name",
      "warehouse_address",
      "company_id",
      "warehouse_image",
      "status",
      "createdAt",
      "updatedAt",
    ], // Fields to include in queries
    searchableFields: ["warehouse_name", "warehouse_address", "company_id"], // Fields that can be searched (excluded parent_product_id as it's ObjectId)
    filterableFields: [], // Fields that can be filtered (empty means filter by all displayed fields)
    sortableFields: [
      "warehouse_name",
      "warehouse_address",
      "company_name",
      "status",
      "createdAt",
    ], // Fields that can be sorted
    baseUrl: BASE_URL, // Base URL for the application
    softDelete: true, // Enable soft delete functionality
    fieldTypes: {
      warehouse_image: "file", // File upload field for single image
      status: "select", // Dropdown select field
    },
    fieldLabels: {
      warehouse_name: "Warehouse Name",
      warehouse_address: "Address",
      company_name: "Company Name",
      warehouse_image: "Warehouse Image",
      status: "Status",
    },
    fieldOptions: {
      company_name: {
        name: "company_name",
        type: "text",
        label: "Company Name",
        required: false,
        validation: {},
        options: [],
        placeholder: "Company Name",
        helpText: "Company name",
      },
    },
    middleware: {
      afterQuery: async (records, req) => {
        // Populate company_id for all records that have it
        const populatedRecords = await Warehouse.populate(records, [
          {
            path: "company_id",
            select: "company_name",
          },
        ]);

        // Add company_name field to fieldConfig so it shows in the list view
        if (req.fieldConfig) {
          req.fieldConfig.company_name = {
            name: "company_name",
            type: "text",
            label: "Company Name",
            required: false,
            validation: {},
            options: [],
            placeholder: "Company Name",
            helpText: "Company name",
          };
        }

        // Note: Dropdown options are set in beforeCreateForm/beforeEditForm middleware
        // This afterQuery middleware is only for populating existing records in list views

        return populatedRecords; // Return populated records with company data
      },

      // Fetch warehouses before rendering create form
      beforeCreateForm: async (req, res) => {
        try {
          // Fetch all active companies for company_id dropdown
          const companies = await Company.find({
            status: "active", // Only active companies
            deletedAt: null, // Only non-deleted companies
          })
            .select("company_name")
            .sort({ company_name: 1 }); // Select company details and sort by name
          console.log("companies_find", companies);
          // Add companies to request object for view access
          req.companies = companies; // Store companies in request for form access
          req.fieldConfig.company_id.options = companies.map((company) => ({
            value: company._id.toString(),
            label: company.company_name,
          }));
          req.fieldConfig.company_id.placeholder = "Select Company";
          req.fieldConfig.company_id.helpText =
            "Choose the company for this warehouse";
        } catch (error) {
          console.error("Error fetching data:", error); // Log any errors
          req.warehouses = []; // Set empty array on error
        }
      },
      // Fetch warehouses before rendering edit form
      beforeEditForm: async (req, res) => {
        // try {

        // } catch (error) {

        // }
        try {
          // Fetch all active companies for company_id dropdown
          const companies = await Company.find({
            status: "active", // Only active companies
            deletedAt: null, // Only non-deleted companies
          })
            .select("company_name")
            .sort({ company_name: 1 }); // Select company details and sort by name

          // Add companies to request object for view access
          req.companies = companies; // Store companies in request for form access
          req.fieldConfig.company_id.options = companies.map((company) => ({
            value: company._id.toString(),
            label: company.company_name,
          }));
          req.fieldConfig.company_id.placeholder = "Select Company";
          req.fieldConfig.company_id.helpText =
            "Choose the company for this warehouse";

          // Fetch all active warehouses
          // console.log('🔍 Field config exists:', !!req.fieldConfig); // Debug log of field config existence
          // console.log('🔍 Warehouse field exists:', !!req.fieldConfig?.warehouse_id); // Debug log of specific field existence
          // console.log('🔍 Final fieldConfig keys:', Object.keys(req.fieldConfig || {}));
        } catch (error) {
          console.error("Error fetching data:", error); // Log any errors
          req.warehouses = []; // Set empty array on error
        }
      },
      // Process warehouse inventory before insert
    },
    // Custom response formatting to show company name instead of ObjectId
    responseFormatting: {
      list: async (records) => {
        return records.map((record) => {
          const recordObj = record.toObject ? record.toObject() : record;
          if (recordObj.company_id?.company_name) {
            recordObj.company_id = recordObj.company_id.company_name;
          }
          return recordObj;
        });
      },
    },
  },
);

const complainAdminCRUD = adminCrudGenerator(
  Complain,
  "complain",
  ["title", "description", "user_id", "image"], // Headings.
  {
    excludedFields: ["__v"],
    includedFields: ["title", "description", "user_id", "image", "createdAt"],
    searchableFields: ["title", "description"],
    filterableFields: ["user_id"],
    sortableFields: ["title", "description", "user_id", "createdAt"],
    baseUrl: BASE_URL,
    softDelete: true, // Enable soft delete functionality
    fieldTypes: {
      description: "textarea",
      image: "file",
      user_id: "select",
    },
    fieldLabels: {
      image: "Blog Image",
      user_id: "Posted User",
    },
    fieldOptions: {
      user_id: [], // Will be populated dynamically
    },
    middleware: {
      afterQuery: async (records, req) => {
        const populatedRecords = await Complain.populate(records, {
          path: "user_id",
          select: "name email",
        });

        if (req.fieldConfig?.user_id) {
          const users = await User.find(
            { deletedAt: { $exists: false } },
            "name email",
          ).sort({ name: 1 });
          req.fieldConfig.user_id.options = users.map((user) => ({
            value: user._id.toString(),
            label: user.name,
          }));
          req.fieldConfig.user_id.placeholder = "Select User";
          req.fieldConfig.user_id.helpText =
            "Choose the user who posted this complaint";
        }

        return populatedRecords;
      },
    },
    // Custom response formatting to show user name
    responseFormatting: {
      list: async (records) =>
        records.map((record) => {
          const recordObj = record.toObject ? record.toObject() : record;
          if (recordObj.user_id?.name) {
            recordObj.user_name = recordObj.user_id.name;
            recordObj.user_email = recordObj.user_id.email;
          }
          return recordObj;
        }),
    },
  },
);

/**
 * Auto-generate Admin CRUD with UI Forms for integration model
 */
const processAdminCRUD = adminCrudGenerator(
  Process,
  "process",
  [
    "integration_id",
    "product_id",
    "action",
    "count",
    "page",
    "offset",
    "limit",
    "priority",
    "remarks",
    "status",
    "created_by",
    "company_id",
    "company_name",
    "status",
  ],
  {
    excludedFields: ["__v"],
    includedFields: [
      "integration_id",
      "product_id",
      "action",
      "count",
      "page",
      "offset",
      "limit",
      "priority",
      "remarks",
      "status",
      "created_by",
      "company_id",
      "company_name",
      "status",
      "createdAt",
    ],
    searchableFields: [
      "integration_id",
      "product_id",
      "action",
      "count",
      "page",
      "offset",
      "limit",
      "priority",
      "remarks",
      "status",
      "created_by",
      "company_id",
      "company_name",
      "status",
      "createdAt",
    ],
    filterableFields: [
      "integration_id",
      "product_id",
      "action",
      "count",
      "page",
      "offset",
      "limit",
      "priority",
      "remarks",
      "status",
      "created_by",
      "company_id",
      "company_name",
      "status",
      "createdAt",
    ],
    sortableFields: [
      "integration_id",
      "product_id",
      "action",
      "count",
      "page",
      "offset",
      "limit",
      "priority",
      "remarks",
      "status",
      "created_by",
      "company_id",
      "company_name",
      "status",
      "createdAt",
    ],
    baseUrl: BASE_URL,
    softDelete: true,
    fieldTypes: {
      store_type: "select",
      description: "textarea",
      image: "file",
      company_id: "select",
      created_by: "select",
      status: "select",
      company_name: "text", // Display field for company name
    },
    fieldLabels: {
      company_name: "Company",
    },
    fieldOptions: {
      store_type: [
        { value: "shopify", label: "Shopify" },
        { value: "woocommerce", label: "WooCommerce" },
        { value: "daraz", label: "Daraz" },
      ],
      status: [
        { value: "active", label: "Active" },
        { value: "inactive", label: "Inactive" },
      ],
    },

    middleware: {
      afterQuery: async (records, req) => {
        // Populate both company_id and created_by
        const populatedRecords = await Integration.populate(records, [
          { path: "company_id", select: "company_name" },
          { path: "created_by", select: "name email" },
        ]);

        // Add both User name and Company name fields for display in list view
        const recordsWithPopulatedFields = populatedRecords.map((record) => {
          const recordObj = record.toObject ? record.toObject() : record;

          // Handle created_by field
          if (record.created_by) {
            recordObj.created_by = record.created_by.name || "No User";
          } else {
            recordObj.created_by = "No User";
          }

          // Handle company_id field
          if (record.company_id) {
            recordObj.company_id =
              record.company_id.company_name || "No Company";
          } else {
            recordObj.company_id = "No Company";
          }

          return recordObj;
        });

        return recordsWithPopulatedFields;
      },
      beforeCreateForm: async (req, res) => {
        const companies = await Company.find({
          status: "active",
          deletedAt: null,
        })
          .select("company_name")
          .sort({ company_name: 1 });
        req.fieldConfig.company_id.options = companies.map((company) => ({
          value: company._id.toString(),
          label: company.company_name,
        }));
        const users = await User.find({ deletedAt: null }, "name email").sort({
          name: 1,
        });
        req.fieldConfig.created_by.options = users.map((user) => ({
          value: user._id.toString(),
          label: user.name,
        }));
        req.fieldConfig.created_by.placeholder = "Select User";
        req.fieldConfig.created_by.helpText =
          "Choose the user who created this integration";
      },
      beforeEditForm: async (req, res) => {
        const companies = await Company.find({
          status: "active",
          deletedAt: null,
        })
          .select("company_name")
          .sort({ company_name: 1 });
        req.fieldConfig.company_id.options = companies.map((company) => ({
          value: company._id.toString(),
          label: company.company_name,
        }));

        const users = await User.find({ deletedAt: null }, "name email").sort({
          name: 1,
        });
        req.fieldConfig.created_by.options = users.map((user) => ({
          value: user._id.toString(),
          label: user.name,
        }));
        req.fieldConfig.created_by.placeholder = "Select User";
        req.fieldConfig.created_by.helpText =
          "Choose the user who created this integration";
      },
    },
  },
);

/**
 * Auto-generate Admin CRUD with UI Forms for integration model
 */
const integrationAdminCRUD = adminCrudGenerator(
  Integration,
  "integration",
  [
    "store_type",
    "name",
    "address",
    "city",
    "state",
    "email",
    "phone",
    "url",
    "secret",
    "key",
    "token",
    "description",
    "image",
    "created_by",
    "company_id",
    "company_name",
    "status",
  ],
  {
    excludedFields: ["__v"],
    includedFields: [
      "store_type",
      "created_by",
      "name",
      "address",
      "city",
      "state",
      "email",
      "phone",
      "url",
      "secret",
      "key",
      "description",
      "image",
      "company_id",
      "company_name",
      "status",
      "createdAt",
    ],
    searchableFields: ["name", "store_type", "email", "url"],
    filterableFields: ["store_type", "status"],
    sortableFields: ["name", "store_type", "created_by", "status", "createdAt"],
    baseUrl: BASE_URL,
    softDelete: true,
    fieldTypes: {
      store_type: "select",
      description: "textarea",
      image: "file",
      company_id: "select",
      created_by: "select",
      status: "select",
      company_name: "text", // Display field for company name
    },
    fieldLabels: {
      company_name: "Company",
    },
    fieldOptions: {
      store_type: [
        { value: "shopify", label: "Shopify" },
        { value: "woocommerce", label: "WooCommerce" },
        { value: "daraz", label: "Daraz" },
      ],
      status: [
        { value: "active", label: "Active" },
        { value: "inactive", label: "Inactive" },
      ],
    },

    middleware: {
      afterQuery: async (records, req) => {
        // Populate both company_id and created_by
        const populatedRecords = await Integration.populate(records, [
          { path: "company_id", select: "company_name" },
          { path: "created_by", select: "name email" },
        ]);

        // Add both User name and Company name fields for display in list view
        const recordsWithPopulatedFields = populatedRecords.map((record) => {
          const recordObj = record.toObject ? record.toObject() : record;

          // Handle created_by field
          if (record.created_by) {
            recordObj.created_by = record.created_by.name || "No User";
          } else {
            recordObj.created_by = "No User";
          }

          // Handle company_id field
          if (record.company_id) {
            recordObj.company_id =
              record.company_id.company_name || "No Company";
          } else {
            recordObj.company_id = "No Company";
          }

          return recordObj;
        });

        return recordsWithPopulatedFields;
      },
      beforeCreateForm: async (req, res) => {
        const companies = await Company.find({
          status: "active",
          deletedAt: null,
        })
          .select("company_name")
          .sort({ company_name: 1 });
        req.fieldConfig.company_id.options = companies.map((company) => ({
          value: company._id.toString(),
          label: company.company_name,
        }));
        const users = await User.find({ deletedAt: null }, "name email").sort({
          name: 1,
        });
        req.fieldConfig.created_by.options = users.map((user) => ({
          value: user._id.toString(),
          label: user.name,
        }));
        req.fieldConfig.created_by.placeholder = "Select User";
        req.fieldConfig.created_by.helpText =
          "Choose the user who created this integration";
      },
      beforeEditForm: async (req, res) => {
        const companies = await Company.find({
          status: "active",
          deletedAt: null,
        })
          .select("company_name")
          .sort({ company_name: 1 });
        req.fieldConfig.company_id.options = companies.map((company) => ({
          value: company._id.toString(),
          label: company.company_name,
        }));

        const users = await User.find({ deletedAt: null }, "name email").sort({
          name: 1,
        });
        req.fieldConfig.created_by.options = users.map((user) => ({
          value: user._id.toString(),
          label: user.name,
        }));
        req.fieldConfig.created_by.placeholder = "Select User";
        req.fieldConfig.created_by.helpText =
          "Choose the user who created this integration";
      },
    },
  },
);

/**
 * Auto-generate Admin CRUD with UI Forms for integration model
 */
const brandsAdminCRUD = adminCrudGenerator(
  Brands,
  "brands",
  [
    "name",
    "description",
    "slug",
    "image",
    "company_id",
    "created_by",
    "status",
  ],
  {
    excludedFields: ["__v"],
    includedFields: [
      "name",
      "description",
      "slug",
      "image",
      "createdAt",
      "company_id",
      "created_by",
      "status",
    ],
    searchableFields: [
      "name",
      "description",
      "slug",
      "company_id",
      "created_by",
      "status",
    ],
    filterableFields: ["status", "company_id", "created_by"],
    sortableFields: [
      "name",
      "description",
      "slug",
      "createdAt",
      "company_id",
      "created_by",
      "status",
    ],
    baseUrl: BASE_URL,
    softDelete: true,
    fieldTypes: {
      description: "textarea",
      image: "file",
      company_id: "select",
      created_by: "select",
      status: "select",
    },
    fieldLabels: {
      image: "Brand Image",
      company_id: "Company",
      created_by: "Created By",
      status: "Status",
    },
    fieldOptions: {
      status: [
        { value: "active", label: "Active" },
        { value: "inactive", label: "Inactive" },
      ],
    },

    middleware: {
      afterQuery: async (records, req) => {
        // Populate both company_id and created_by
        const populatedRecords = await Integration.populate(records, [
          { path: "company_id", select: "company_name" },
          { path: "created_by", select: "name email" },
        ]);

        // Add both User name and Company name fields for display in list view
        const recordsWithPopulatedFields = populatedRecords.map((record) => {
          const recordObj = record.toObject ? record.toObject() : record;

          // Handle created_by field
          if (record.created_by) {
            recordObj.created_by = record.created_by.name || "No User";
          } else {
            recordObj.created_by = "No User";
          }

          // Handle company_id field
          if (record.company_id) {
            recordObj.company_id =
              record.company_id.company_name || "No Company";
          } else {
            recordObj.company_id = "No Company";
          }

          return recordObj;
        });

        return recordsWithPopulatedFields;
      },
      beforeCreateForm: async (req, res) => {
        const companies = await Company.find({
          status: "active",
          deletedAt: null,
        })
          .select("company_name")
          .sort({ company_name: 1 });
        // console.log('companies', companies);
        req.fieldConfig.company_id.options = companies.map((company) => ({
          value: company._id.toString(),
          label: company.company_name,
        }));
        const users = await User.find({ deletedAt: null }, "name email").sort({
          name: 1,
        });
        req.fieldConfig.created_by.options = users.map((user) => ({
          value: user._id.toString(),
          label: user.name,
        }));
        req.fieldConfig.created_by.placeholder = "Select User";
        req.fieldConfig.created_by.helpText =
          "Choose the user who created this integration";
      },
      beforeEditForm: async (req, res) => {
        const companies = await Company.find({
          status: "active",
          deletedAt: null,
        })
          .select("company_name")
          .sort({ company_name: 1 });
        req.fieldConfig.company_id.options = companies.map((company) => ({
          value: company._id.toString(),
          label: company.company_name,
        }));

        const users = await User.find({ deletedAt: null }, "name email").sort({
          name: 1,
        });
        req.fieldConfig.created_by.options = users.map((user) => ({
          value: user._id.toString(),
          label: user.name,
        }));
        req.fieldConfig.created_by.placeholder = "Select User";
        req.fieldConfig.created_by.helpText =
          "Choose the user who created this integration";
      },
    },
  },
);

/**
 * Auto-generate Admin CRUD with UI Forms for Category model (Minimal Setup Example)
 */
const categoryAdminCRUD = adminCrudGenerator(
  Category,
  "categories",
  [
    "parent_id",
    "name",
    "description",
    "isActive",
    "icon",
    "color",
    "image",
    "sort_order",
    "status",
    "company_id",
  ],
  {
    excludedFields: ["__v"],
    includedFields: [
      "parent_id",
      "name",
      "description",
      "isActive",
      "icon",
      "color",
      "image",
      "sort_order",
      "status",
      "createdAt",
      "company_id",
    ],
    searchableFields: ["name", "description"],
    filterableFields: ["isActive"],
    sortableFields: ["name", "sort_order", "createdAt"],
    baseUrl: BASE_URL,
    softDelete: true, // Enable soft delete functionality
    fieldTypes: {
      isActive: "checkbox",
      sort_order: "number",
      description: "textarea",
      parent_id: "select",
      image: "file",
      company_id: "select",
      // created_by: "select",
    },
    fieldLabels: {
      parent_id: "Parent Category",
    },
    fieldOptions: {
      isActive: [
        { value: true, label: "Active" },
        { value: false, label: "Inactive" },
      ],
    },
    middleware: {
      afterQuery: async (records, req) => {
        const populatedRecords = await Integration.populate(records, [
          { path: "company_id", select: "company_name" },
          { path: "created_by", select: "name email" },
          { path: "parent_id", select: "name" },
        ]);

        if (req.fieldConfig?.parent_id) {
          const categories = await Category.find(
            { deletedAt: null },
            "name",
          ).sort({ name: 1 });
          req.fieldConfig.parent_id.options = [
            { value: "", label: "None (Top Level Category)" },
            ...categories.map((category) => ({
              value: category._id.toString(),
              label: category.name,
            })),
          ];
          req.fieldConfig.parent_id.placeholder = "Select Parent Category";
          req.fieldConfig.parent_id.helpText =
            "Choose the parent category (optional)";
        }
        if (req.fieldConfig?.company_id) {
          const companies = await Company.find(
            { deletedAt: null },
            "company_name",
          ).sort({ company_name: 1 });
          req.fieldConfig.company_id.options = [
            { value: "", label: "None" },
            ...companies.map((company) => ({
              value: company._id.toString(),
              label: company.company_name,
            })),
          ];
          req.fieldConfig.company_id.placeholder = "Select Company";
          req.fieldConfig.company_id.helpText = "Choose the company (optional)";
        }
        // Add both User name and Company name fields for display in list view
        const recordsWithPopulatedFields = populatedRecords.map((record) => {
          const recordObj = record.toObject ? record.toObject() : record;

          // Handle created_by field
          if (record.created_by) {
            recordObj.created_by = record.created_by.name || "No User";
          } else {
            recordObj.created_by = "No User";
          }

          if (record.parent_id) {
            recordObj.parent_id = record.parent_id.name || "No Parent Category";
          } else {
            recordObj.parent_id = "No Parent Category";
          }

          return recordObj;
        });

        // const populatedRecords = await Category.populate(records, {  });
        console.log("populatedRecords", populatedRecords);

        return recordsWithPopulatedFields;
      },
    },
    responseFormatting: {
      list: async (records) =>
        records.map((record) => {
          const recordObj = record.toObject ? record.toObject() : record;
          // If parent_id is populated, convert it to display the name
          if (recordObj.parent_id) {
            if (
              typeof recordObj.parent_id === "object" &&
              recordObj.parent_id.name
            ) {
              recordObj.parent_id = recordObj.parent_id.name;
            }
          } else {
            recordObj.parent_id = "Top Level";
          }
          return recordObj;
        }),
    },
    fieldOptions: {
      isActive: [
        { value: true, label: "Active" },
        { value: false, label: "Inactive" },
      ],
    },
  },
);

/**
 * Auto-generate Admin CRUD with UI Forms for Logs model
 */
const logsAdminCRUD = adminCrudGenerator(
  Logs,
  "logs",
  ["action", "url", "tags", "description", "company_id", "status"],
  {
    listHiddenFields: ["action", "description"],
    excludedFields: ["__v"],
    includedFields: [
      "action",
      "url",
      "tags",
      "description",
      "company_id",
      "created_by",
      "status",
      "createdAt",
      "updatedAt",
    ],
    searchableFields: ["action", "url", "description"],
    filterableFields: ["status", "company_id"],
    sortableFields: ["action", "url", "createdAt", "updatedAt"],
    baseUrl: BASE_URL,
    softDelete: true,
    fieldTypes: {
      description: "textarea",
      tags: "text",
      url: "url",
      company_id: "select",
      created_by: "select",
      status: "select",
    },
    fieldProcessing: {
      beforeInsert: async (data, req) => {
        // Convert comma-separated tags string to array
        if (data.tags && typeof data.tags === "string") {
          data.tags = data.tags
            .split(",")
            .map((tag) => tag.trim())
            .filter((tag) => tag !== "");
        }
        return data;
      },
      beforeUpdate: async (data, req) => {
        // Convert comma-separated tags string to array
        if (data.tags && typeof data.tags === "string") {
          data.tags = data.tags
            .split(",")
            .map((tag) => tag.trim())
            .filter((tag) => tag !== "");
        }
        return data;
      },
    },
    fieldLabels: {
      action: "Action",
      url: "URL",
      tags: "Tags (comma-separated)",
      description: "Description",
      company_id: "Company",
      created_by: "Created By",
      status: "Status",
    },
    fieldOptions: {
      status: [
        { value: "active", label: "Active" },
        { value: "inactive", label: "Inactive" },
      ],
      company_id: [], // Will be populated dynamically
      created_by: [], // Will be populated dynamically
    },
    middleware: {
      afterQuery: async (records, req) => {
        const populatedRecords = await Logs.populate(records, [
          { path: "company_id", select: "company_name" },
          { path: "created_by", select: "name email" },
        ]);

        // Populate company_id options
        if (req.fieldConfig?.company_id) {
          const companies = await Company.find(
            { deletedAt: null },
            "company_name",
          ).sort({ company_name: 1 });
          req.fieldConfig.company_id.options = [
            { value: "", label: "None" },
            ...companies.map((company) => ({
              value: company._id.toString(),
              label: company.company_name,
            })),
          ];
          req.fieldConfig.company_id.placeholder = "Select Company";
          req.fieldConfig.company_id.helpText = "Choose the company (optional)";
        }

        // Populate created_by options
        if (req.fieldConfig?.created_by) {
          const users = await User.find(
            { deletedAt: { $exists: false } },
            "name email",
          ).sort({ name: 1 });
          req.fieldConfig.created_by.options = [
            { value: "", label: "None" },
            ...users.map((user) => ({
              value: user._id.toString(),
              label: user.name,
            })),
          ];
          req.fieldConfig.created_by.placeholder = "Select User";
          req.fieldConfig.created_by.helpText = "Choose the user (optional)";
        }

        return populatedRecords;
      },
    },
    responseFormatting: {
      list: async (records) =>
        records.map((record) => {
          const recordObj = record.toObject ? record.toObject() : record;
          // Format tags array for display
          if (Array.isArray(recordObj.tags)) {
            recordObj.tags = recordObj.tags.join(", ");
          }
          // Format company name
          if (recordObj.company_id?.company_name) {
            recordObj.company_name = recordObj.company_id.company_name;
          }
          // Format created_by name
          if (recordObj.created_by?.name) {
            recordObj.created_by_name = recordObj.created_by.name;
          }
          return recordObj;
        }),
      editForm: async (recordData) => {
        // Convert tags array to comma-separated string for form input
        if (Array.isArray(recordData.tags)) {
          recordData.tags = recordData.tags.join(", ");
        }
        return recordData;
      },
    },
  },
);

/**
 * Mount all Admin CRUD routes under /admin
 *
 * This automatically creates:
 * - /admin/users - User CRUD with forms
 * - /admin/products - Product CRUD with forms
 * - /admin/blogs - Blog CRUD with forms
 * - /admin/orders - Order CRUD with forms
 * - /admin/categories - Category CRUD with forms
 * - /admin/logs - Logs CRUD with forms
 */

// Apply admin authentication middleware to all routes
router.use(restrictTo(["ADMIN"]));

// Update existing routes with CRUD controllers
routeRegistry.updateRoute("users", { crudController: userAdminCRUD });
routeRegistry.updateRoute("products", { crudController: productAdminCRUD });
routeRegistry.updateRoute("blogs", { crudController: blogAdminCRUD });
routeRegistry.updateRoute("orders", { crudController: orderAdminCRUD });
routeRegistry.updateRoute("categories", { crudController: categoryAdminCRUD });
routeRegistry.updateRoute("complain", { crudController: complainAdminCRUD });
routeRegistry.updateRoute("company", { crudController: companyAdminCRUD });
routeRegistry.updateRoute("branch", { crudController: branchAdminCRUD });
routeRegistry.updateRoute("account", { crudController: accountAdminCRUD });
routeRegistry.updateRoute("warehouse", { crudController: warehouseAdminCRUD });
routeRegistry.updateRoute("attribute", { crudController: attributeAdminCRUD });
routeRegistry.updateRoute("integration", {
  crudController: integrationAdminCRUD,
});
routeRegistry.updateRoute("process", { crudController: processAdminCRUD });
routeRegistry.updateRoute("brands", { crudController: brandsAdminCRUD });
routeRegistry.updateRoute("logs", { crudController: logsAdminCRUD });

routeRegistry.addCustomTab("products", {
  name: "Stock Transfer",
  path: "/admin/products/stock-transfer",
  icon: "fas fa-exchange-alt",
  description: "Move stock between warehouses",
});

// Add routes data to all requests for dynamic menu rendering (after all routes are registered)
router.use((req, res, next) => {
  req.routes = routeRegistry.getEnabledRoutes();
  req.baseUrl = BASE_URL;
  next();
});

// Product complaints route
router.get("/products/complaints", (req, res) => {
  try {
    const customTabs = routeRegistry.getCustomTabs("products");
    res.render("admin/list", {
      title: "Product Complaints",
      modelName: "products/complaints",
      records: [], // You can fetch actual complaints here
      fieldConfig: {},
      routes: req.routes || [],
      baseUrl: req.baseUrl || BASE_URL,
      customTabs,
      customTabsActivePath: "/admin/products/complaints",
      pagination: {
        currentPage: 1,
        totalPages: 1,
        totalItems: 0,
        itemsPerPage: 10,
        hasNextPage: false,
        hasPrevPage: false,
      },
      filters: {
        search: "",
        applied: [],
        searchable: [],
        filterable: [],
        sortable: [],
      },
    });
  } catch (error) {
    console.error("Product complaints error:", error);
    res.status(500).render("admin/error", {
      title: "Error",
      message: "Error loading product complaints",
      error: { statusCode: 500, message: "Internal server error" },
    });
  }
});

// Product stock transfer routes
router.get(
  "/products/stock-transfer",
  stockTransferController.renderStockTransfer,
);
router.post(
  "/products/stock-transfer",
  stockTransferController.handleStockTransfer,
);

// Mount all registered CRUD routes dynamically
const enabledRoutes = routeRegistry.getEnabledRoutes();
console.log(
  "🔧 Mounting CRUD routes. Enabled routes:",
  enabledRoutes.map((r) => ({ key: r.key || r.name, path: r.path })),
);
enabledRoutes.forEach((route) => {
  if (route.crudController && route.crudController.routes) {
    const routePath = route.path.replace("/admin/", "");
    console.log(
      `🔧 Mounting ${route.name || route.key} routes at /${routePath}`,
    );
    router.use(`/${routePath}`, route.crudController.routes);
    console.log(
      `✅ ${
        route.name || route.key
      } routes mounted successfully at /${routePath}`,
    );

    // Add a test route to verify company routes are accessible
    if (routePath === "company") {
      router.get(`/${routePath}/test`, (req, res) => {
        console.log("✅ Test route hit for company!");
        res.json({ message: "Company routes are working!", path: routePath });
      });
      console.log(
        `✅ Test route added for company at /admin/${routePath}/test`,
      );
    }
  } else {
    console.log(
      `⚠️ Skipping ${route.name || route.key} - no crudController or routes`,
    );
  }
});

/**
 * Admin Dashboard Overview
 * GET /admin/dashboard
 */
router.get("/dashboard", async (req, res) => {
  try {
    // Get quick statistics for dashboard
    const stats = {
      users: await User.countDocuments(),
      products: await Product.countDocuments(),
      blogs: await Blog.countDocuments(),
      orders: await Order.countDocuments(),
      categories: await Category.countDocuments(),
    };

    // Get recent activity
    const recentUsers = await User.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .select("name email createdAt");
    const recentProducts = await Product.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .select("name price createdAt");
    const recentOrders = await Order.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .select("order_number total_amount status createdAt");

    // Get dynamic routes for sidebar  //posPayAmount
    const enabledRoutes = routeRegistry.getEnabledRoutes();

    res.render("admin/dashboard", {
      title: "Admin Dashboard",
      stats,
      recentActivity: {
        users: recentUsers,
        products: recentProducts,
        orders: recentOrders,
      },
      routes: enabledRoutes,
      baseUrl: BASE_URL,
    });
  } catch (error) {
    console.error("Admin dashboard error:", error);
    res.status(500).render("admin/error", {
      title: "Error",
      message: "Error retrieving dashboard data",
      error: { statusCode: 500, message: "Internal server error" },
    });
  }
});

/**
 * Admin System Info
 * GET /admin/system-info
 */
router.get("/system-info", (req, res) => {
  const systemInfo = {
    nodeVersion: process.version,
    platform: process.platform,
    memoryUsage: process.memoryUsage(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || "development",
    timestamp: new Date().toISOString(),
  };

  res.status(200).json({
    success: true,
    message: "System information retrieved successfully",
    data: systemInfo,
  });
});

/**
 * Route Management Endpoints
 */

// Get all routes
router.get("/routes", (req, res) => {
  try {
    const routes = routeRegistry.getAllRoutes();
    const stats = routeRegistry.getStats();

    res.status(200).json({
      success: true,
      message: "Routes retrieved successfully",
      data: {
        routes,
        stats,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error retrieving routes",
      error: error.message,
    });
  }
});

// Get enabled routes (for sidebar)
router.get("/routes/enabled", (req, res) => {
  try {
    const routes = routeRegistry.getEnabledRoutes();

    res.status(200).json({
      success: true,
      message: "Enabled routes retrieved successfully",
      data: routes,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error retrieving enabled routes",
      error: error.message,
    });
  }
});

// Create new route
router.post("/routes", (req, res) => {
  try {
    const { key, name, icon, path, description, order, enabled } = req.body;

    if (!key || !name) {
      return res.status(400).json({
        success: false,
        message: "Key and name are required",
      });
    }

    const route = routeRegistry.registerRoute(key, {
      name,
      icon: icon || "fas fa-cog",
      path: path || `/admin/${key}`,
      description: description || `Manage ${name.toLowerCase()}`,
      order: order || routeRegistry.getNextOrder(),
      enabled: enabled !== false,
    });

    res.status(201).json({
      success: true,
      message: "Route created successfully",
      data: route,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error creating route",
      error: error.message,
    });
  }
});

// Update route
router.put("/routes/:key", (req, res) => {
  try {
    const { key } = req.params;
    const updates = req.body;

    const route = routeRegistry.updateRoute(key, updates);

    if (!route) {
      return res.status(404).json({
        success: false,
        message: "Route not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "Route updated successfully",
      data: route,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error updating route",
      error: error.message,
    });
  }
});

// Toggle route enabled/disabled
router.patch("/routes/:key/toggle", (req, res) => {
  try {
    const { key } = req.params;
    const { enabled } = req.body;

    const route = routeRegistry.toggleRoute(key, enabled);

    if (!route) {
      return res.status(404).json({
        success: false,
        message: "Route not found",
      });
    }

    res.status(200).json({
      success: true,
      message: `Route ${enabled ? "enabled" : "disabled"} successfully`,
      data: route,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error toggling route",
      error: error.message,
    });
  }
});

// Delete route
router.delete("/routes/:key", (req, res) => {
  try {
    const { key } = req.params;

    const deleted = routeRegistry.deleteRoute(key);

    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: "Route not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "Route deleted successfully",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error deleting route",
      error: error.message,
    });
  }
});

// Reorder routes
router.post("/routes/reorder", (req, res) => {
  try {
    const { orderedKeys } = req.body;

    if (!Array.isArray(orderedKeys)) {
      return res.status(400).json({
        success: false,
        message: "orderedKeys must be an array",
      });
    }

    routeRegistry.reorderRoutes(orderedKeys);

    res.status(200).json({
      success: true,
      message: "Routes reordered successfully",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error reordering routes",
      error: error.message,
    });
  }
});

// Route management view
router.get("/routes", (req, res) => {
  try {
    const enabledRoutes = routeRegistry.getEnabledRoutes();

    res.render("admin/route-management", {
      title: "Route Management",
      routes: enabledRoutes,
      baseUrl: BASE_URL,
    });
  } catch (error) {
    console.error("Route management error:", error);
    res.status(500).render("admin/error", {
      title: "Error",
      message: "Error loading route management",
      error: { statusCode: 500, message: "Internal server error" },
    });
  }
});

// Create route form view
router.get("/routes/create", (req, res) => {
  try {
    const enabledRoutes = routeRegistry.getEnabledRoutes();

    res.render("admin/route-management", {
      title: "Create Route",
      routes: enabledRoutes,
      baseUrl: BASE_URL,
      showCreateForm: true,
    });
  } catch (error) {
    console.error("Create route form error:", error);
    res.status(500).render("admin/error", {
      title: "Error",
      message: "Error loading create route form",
      error: { statusCode: 500, message: "Internal server error" },
    });
  }
});

/**
 * Export CRUD controllers for external use
 */
router.get("/crud-controllers", (req, res) => {
  const controllers = {
    users: userAdminCRUD.controller,
    products: productAdminCRUD.controller,
    blogs: blogAdminCRUD.controller,
    orders: orderAdminCRUD.controller,
    categories: categoryAdminCRUD.controller,
    complain: complainAdminCRUD.controller,
    company: companyAdminCRUD.controller,
    branch: branchAdminCRUD.controller,
    account: accountAdminCRUD.controller,
    warehouse: warehouseAdminCRUD.controller,
    integration: integrationAdminCRUD.controller,
    process: processAdminCRUD.controller,
    brands: brandsAdminCRUD.controller,
    attribute: attributeAdminCRUD.controller,
  };

  res.status(200).json({
    success: true,
    message: "Admin CRUD controllers information",
    data: {
      available: Object.keys(controllers),
      endpoints: {
        users: "/admin/users",
        products: "/admin/products",
        blogs: "/admin/blogs",
        orders: "/admin/orders",
        categories: "/admin/categories",
        complain: "/admin/complain",
        company: "/admin/company",
        branch: "/admin/branch",
        warehouse: "/admin/warehouse",
        integration: "/admin/integration",
        process: "/admin/process",
        brands: "/admin/brands",
      },
    },
  });
});

module.exports = router;
