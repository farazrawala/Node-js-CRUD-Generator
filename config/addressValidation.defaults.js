/**
 * Address validation defaults.
 * Override without code changes via `config/addressValidation.json`
 * (merged on top of these defaults at runtime).
 */
module.exports = {
  minimumLength: 15,
  minimumWords: 4,
  /** Score below this → middleware may return 400 when `strict` is true */
  minimumScore: 40,
  /** Below this → LOW confidence / severely incomplete for soft-reject paths */
  severeScoreThreshold: 40,

  weights: {
    houseNumber: 20,
    street: 20,
    area: 20,
    city: 15,
    postalCode: 15,
    country: 10,
  },

  confidence: {
    highMin: 90,
    mediumMin: 70,
  },

  streetKeywords: [
    "street",
    "st",
    "road",
    "rd",
    "avenue",
    "ave",
    "block",
    "sector",
    "phase",
    "lane",
    "plot",
    "house",
    "apartment",
    "apt",
    "flat",
    "shop",
    "building",
    "tower",
    "floor",
    "boulevard",
    "blvd",
    "colony",
    "town",
    "society",
    "mohalla",
    "gali",
  ],

  /** Common city names (extend in addressValidation.json) */
  cities: [
    "karachi",
    "lahore",
    "islamabad",
    "rawalpindi",
    "faisalabad",
    "multan",
    "peshawar",
    "quetta",
    "hyderabad",
    "sialkot",
    "gujranwala",
    "sukkur",
    "abbottabad",
    "bahawalpur",
    "sargodha",
    "london",
    "manchester",
    "birmingham",
    "new york",
    "los angeles",
    "chicago",
    "houston",
    "dubai",
    "abu dhabi",
    "riyadh",
    "jeddah",
  ],

  countries: [
    "pakistan",
    "pk",
    "usa",
    "us",
    "united states",
    "uk",
    "united kingdom",
    "uae",
    "united arab emirates",
    "saudi arabia",
    "sa",
    "canada",
    "ca",
    "india",
    "in",
  ],

  /** Suspicious / placeholder phrases (substring or whole-token match) */
  blacklist: [
    "home",
    "office",
    "shop",
    "near mosque",
    "near market",
    "unknown",
    "abc",
    "xyz",
    "test",
    "none",
    "n/a",
    "na",
    "asdf",
    "qwerty",
  ],

  /**
   * Postal code patterns by country code / name key (case-insensitive).
   * Use string form; compiled to RegExp at load.
   */
  postalCodePatterns: {
    pakistan: "^\\d{5}$",
    pk: "^\\d{5}$",
    us: "^\\d{5}(-\\d{4})?$",
    usa: "^\\d{5}(-\\d{4})?$",
    "united states": "^\\d{5}(-\\d{4})?$",
    uk: "^[A-Z]{1,2}\\d[A-Z\\d]?\\s*\\d[A-Z]{2}$",
    "united kingdom": "^[A-Z]{1,2}\\d[A-Z\\d]?\\s*\\d[A-Z]{2}$",
    default: "^[A-Z0-9][A-Z0-9\\s\\-]{2,10}$",
  },

  /** Tokens ignored when counting "meaningful" words */
  stopWords: ["the", "a", "an", "of", "in", "at", "to", "and", "or", "near"],

  gibberish: {
    /** Max ratio of unique short nonsense tokens before penalty */
    minAvgTokenLength: 2.5,
    /** If > this fraction of tokens look like keyboard mash, flag gibberish */
    nonsenseTokenRatio: 0.5,
  },
};
