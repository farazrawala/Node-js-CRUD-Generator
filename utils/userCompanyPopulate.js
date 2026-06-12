/** Default GL / warehouse refs on `company` — keep in sync with `models/company.js`. */
const COMPANY_DEFAULT_ACCOUNT_PATHS = [
  "default_cash_account",
  "default_sales_account",
  "default_purchase_account",
  "default_sales_discount_account",
  "default_purchase_discount_account",
  "default_account_receivable_account",
  "default_account_payable_account",
  "default_shipping_account",
  "default_expense_account",
  "default_salary_account",
  "default_equity_account_id",
  "default_adjustment_account",
  "default_other_expense_account",
  "default_utilities_account",
];

const ACCOUNT_SELECT = "name account_number company_id account_type status";

/** Scalar company fields the client expects on login / auth even when unset in MongoDB. */
const COMPANY_CLIENT_SCALAR_FIELDS = [
  "company_logo",
  "barcode_settings",
  "printer_settings",
];

/** Ensure populated `company_id` includes stable keys for the client (null when unset). */
function normalizePopulatedCompanyForClient(company) {
  if (!company || typeof company !== "object") return company;
  [
    ...COMPANY_DEFAULT_ACCOUNT_PATHS,
    "warehouse_id",
    ...COMPANY_CLIENT_SCALAR_FIELDS,
  ].forEach((field) => {
    if (company[field] === undefined) {
      company[field] = null;
    }
  });
  return company;
}

/** Full company document + populated default accounts and warehouse (login / auth). */
function buildUserCompanyPopulate() {
  return {
    path: "company_id",
    populate: [
      ...COMPANY_DEFAULT_ACCOUNT_PATHS.map((path) => ({
        path,
        select: ACCOUNT_SELECT,
      })),
      { path: "warehouse_id", select: "name status company_id" },
    ],
  };
}

module.exports = {
  COMPANY_DEFAULT_ACCOUNT_PATHS,
  COMPANY_CLIENT_SCALAR_FIELDS,
  normalizePopulatedCompanyForClient,
  buildUserCompanyPopulate,
};
