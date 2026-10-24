const mongoose = require("mongoose");

/** Per-company WhatsApp automation settings (one row per company). */
const DEFAULT_BUSINESS_HOURS = [
  { day: "Monday", open: true, from: "10:00", to: "19:00" },
  { day: "Tuesday", open: true, from: "10:00", to: "19:00" },
  { day: "Wednesday", open: true, from: "10:00", to: "19:00" },
  { day: "Thursday", open: true, from: "10:00", to: "19:00" },
  { day: "Friday", open: true, from: "10:00", to: "19:00" },
  { day: "Saturday", open: true, from: "11:00", to: "17:00" },
  { day: "Sunday", open: false, from: "11:00", to: "17:00" },
];

const DEFAULT_SETTINGS = Object.freeze({
  automation_enabled: true,
  session_timeout_minutes: 30,
  reply_window_minutes: 60,
  combine_messages: true,
  fallback_message: "Sorry, I didn't get that. Please reply with one of the numbers below.",
  thanks_message: "You're welcome! 😊 Reply *menu* anytime if you need anything else.",
  /** Where the POS is opened (e.g. https://…/pos), for public shop product links. */
  app_url: "",
  business_hours: DEFAULT_BUSINESS_HOURS,
});

const hoursSchema = new mongoose.Schema(
  {
    day: { type: String, required: true },
    open: { type: Boolean, default: false },
    from: { type: String, default: "10:00" },
    to: { type: String, default: "19:00" },
  },
  { _id: false },
);

const modelSchema = new mongoose.Schema(
  {
    automation_enabled: { type: Boolean, default: DEFAULT_SETTINGS.automation_enabled, field_name: "Enabled" },
    session_timeout_minutes: {
      type: Number,
      min: 1,
      max: 1440,
      default: DEFAULT_SETTINGS.session_timeout_minutes,
      field_name: "Session Timeout (min)",
    },
    reply_window_minutes: {
      type: Number,
      min: 1,
      max: 10080,
      default: DEFAULT_SETTINGS.reply_window_minutes,
      field_name: "Reply Window (min)",
    },
    combine_messages: { type: Boolean, default: DEFAULT_SETTINGS.combine_messages, field_name: "Combine Messages" },
    fallback_message: {
      type: String,
      maxlength: 1000,
      default: DEFAULT_SETTINGS.fallback_message,
      field_name: "Fallback Message",
    },
    thanks_message: {
      type: String,
      maxlength: 1000,
      default: DEFAULT_SETTINGS.thanks_message,
      field_name: "Reply To Thanks",
    },
    app_url: { type: String, maxlength: 300, default: "", field_name: "POS Address" },
    business_hours: { type: [hoursSchema], default: () => DEFAULT_BUSINESS_HOURS.map((d) => ({ ...d })) },

    company_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "company",
      required: true,
      unique: true,
      field_name: "Company",
    },
    updated_by: { type: mongoose.Schema.Types.ObjectId, ref: "user", field_name: "Updated By" },
  },
  { timestamps: true },
);

const MODEL = mongoose.model("wa_automation_settings", modelSchema);

module.exports = MODEL;
module.exports.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
