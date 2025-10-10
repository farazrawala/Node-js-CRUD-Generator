const Url = require("../models/url");
const shortid = require("shortid");

async function handleGetallUrls(req, res) {
  const allUrls = await Url.find({});
  return res.json(allUrls);
}

async function handFetchUrl(req, res) {
  const shortid = req.params.id;
  console.log("Searching for shortid:", shortid);

  try {
    // First, let's check if the document exists
    const existingEntry = await Url.findOne({ shortid });
    console.log("Existing entry:", existingEntry);

    if (!existingEntry) {
      return res.status(404).json({ error: "URL not found with this shortid" });
    }

    const entry = await Url.findOneAndUpdate(
      { shortid },
      {
        $push: {
          visitHistory: {
            timestamp: Date.now(),
          },
        },
      },
      { new: true } // This returns the updated document
    );

    res.redirect(entry.redirectUrl);
  } catch (error) {
    console.log("error__", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}

async function handleCreateurl(req, res) {
  const body = req.body;
  console.log(body);
  const result = await Url.create({
    shortid: shortid.generate(),
    redirectUrl: body.redirect_url,
    // visitHistory: [],
  });
  return res.status(201).json({ msg: "URL created successfully.", result });
}

module.exports = {
  handleGetallUrls,
  handleCreateurl,
  handFetchUrl,
};
