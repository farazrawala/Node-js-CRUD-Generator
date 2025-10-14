const express = require("express");
const router = express.Router();

const {
  handleUserSignup,
  handleUserSignupCompany,
  handleUserLogin,
  handleUserUpdate,
  getAllUser,
  userById,
  handleAdminLogin,
  findUserByEmail,
} = require("../controllers/user");

const {
  productCreate,
  productUpdate,
  productById,
  getAllProducts,
} = require("../controllers/product");

const {
  blogCreate,
  blogUpdate,
  blogById,
  getAllBlog,
  getallblogactive,
  blogdelete,
} = require("../controllers/blog");



const {
  companyCreate,
  companyUpdate,
  companyById,
  getAllcompany,
  getallcompanyactive,
  companydelete,
} = require("../controllers/company");



const {
  complainCreate,
  complainUpdate,
  complainById,
  getAllcomplain,
} = require("../controllers/complain");



const {
  orderCreate,
  orderUpdate,
  orderById,
  getAllorder,
} = require("../controllers/order");

const {
  order_itemCreate,
  order_itemUpdate,
  order_itemById,
  getAllorder_item,
} = require("../controllers/order_item");




router.post("/user/user_company", handleUserSignupCompany);
router.post("/user/create", handleUserSignup);
router.patch("/user/update/:id", handleUserUpdate);
router.post("/user/login", handleUserLogin);
router.get("/user/get-all", getAllUser);
router.get("/user/get/:id", userById);
router.post("/user/get-one", findUserByEmail);

router.post("/product/create", productCreate);
router.patch("/product/update/:id", productUpdate);
router.get("/product/get/:id", productById);
router.get("/product/get-all", getAllProducts);

router.post("/blog/create", blogCreate);
router.patch("/blog/update/:id", blogUpdate);
router.get("/blog/get/:id", blogById);
router.get("/blog/get-all", getAllBlog);
router.get("/blog/get-all-active", getallblogactive);
router.delete("/blog/delete/:id", blogdelete);
// router.get("/blog/get-one/:id", findOneblog); //

router.post("/company/create", companyCreate);
router.patch("/company/update/:id", companyUpdate);
router.get("/company/get/:id", companyById);
router.get("/company/get-all", getAllcompany);
router.get("/company/get-all-active", getallcompanyactive);
router.delete("/company/delete/:id", companydelete);

router.post("/complain/create", complainCreate);
router.patch("/complain/update/:id", complainUpdate);
router.get("/complain/get/:id", complainById);
router.get("/complain/get-all", getAllcomplain);

router.post("/order/create", orderCreate);
router.patch("/order/update/:id", orderUpdate);
router.get("/order/get/:id", orderById);
router.get("/order/get-all", getAllorder);

router.post("/order_item/create", order_itemCreate);
router.patch("/order_item/update/:id", order_itemUpdate);
router.get("/order_item/get/:id", order_itemById);
router.get("/order_item/get-all", getAllorder_item);

router.post("/test", (req, res) => {
  console.log("Test route hit");
  res.status(200).json({ message: "Test successful" });
});

// Admin routes
router.post("/login/admin", handleAdminLogin);

module.exports = router;
