# Admin Custom Tabs Guide

This guide explains how to add feature-specific tabs to the admin list view for any auto-generated module. Custom tabs appear beside the default “List” tab and let you build fully custom pages (e.g. the `Stock Transfer` page for products) while retaining the standard admin chrome.

---

## Overview

Custom tabs combine three pieces:

1. **Tab registration** – Tell the admin router that a module has an extra tab (label, path, icon, description).
2. **Page implementation** – Create an Express route + controller + EJS view for the new tab.
3. **Tab rendering** – The list view automatically renders tabs when they exist; no extra changes are required once the tab is registered.

The admin generator (`adminCrudGenerator`) already looks up custom tabs and passes the active tab info into `views/admin/list.ejs`.

---

## 1. Register a tab

Call `routeRegistry.addCustomTab(<moduleKey>, config)` after the module’s CRUD controller is registered (typically inside `routes/admin.js`).

```js
const routeRegistry = require('../utils/routeRegistry');

routeRegistry.addCustomTab('products', {
  name: 'Stock Transfer',
  path: '/admin/products/stock-transfer',
  icon: 'fas fa-exchange-alt',          // optional Font Awesome icon
  description: 'Move stock between warehouses'
});
```

- `moduleKey` must match the key used when registering the CRUD controller (e.g. `'products'`, `'users'`, `'orders'`, …).
- The `path` should be the full admin URL you plan to implement.
- `icon` is optional. If omitted, a generic icon is shown.

You can register multiple tabs per module by calling `addCustomTab` repeatedly with different `path` values.

---

## 2. Build the custom page

Create standard Express routes that render whatever UI you need. The custom tab engine expects:

1. A **GET** route returning an EJS view (or JSON if it’s an API-only tab).
2. Optional POST/PUT/DELETE routes to back the page’s interactions.

Example (from `routes/admin.js`):

```js
const stockTransferController = require('../controllers/stockTransfer');

router.get('/products/stock-transfer', stockTransferController.renderStockTransfer);
router.post('/products/stock-transfer', stockTransferController.handleStockTransfer);
```

Inside the controller:

```js
res.render('admin/product-stock-transfer', {
  title: 'Product Stock Transfer',
  modelName: 'products',
  // …
  routes: req.routes,                   // required for sidebar
  baseUrl: req.baseUrl,                 // required for assets
  customTabs: routeRegistry.getCustomTabs('products'),
  customTabsActivePath: '/admin/products/stock-transfer'
});
```

Key props to send to the view:

| Prop                     | Purpose                                                |
|-------------------------|--------------------------------------------------------|
| `routes`                | Renders the left admin navigation (provided by middleware). |
| `baseUrl`               | Ensures assets/images resolve correctly.               |
| `customTabs`            | The tab list (use `routeRegistry.getCustomTabs(key)`). |
| `customTabsActivePath`  | Highlights the active tab. Use the page’s absolute path. |

> **Tip**  
> The admin middleware in `routes/admin.js` already populates `req.routes` and `req.baseUrl` for every request after authentication, so your controller just needs to forward them into the template.

---

## 3. Create the view

You can clone `views/admin/product-stock-transfer.ejs` as a starting template:

- Keeps the standard header, sidebar, and layout.
- Displays the tab strip using the data passed in step 2.
- Adds custom content (forms, tables, charts, etc.).

To highlight the correct tab in your EJS:

```ejs
<a href="/admin/<%= modelName %>"
   class="... <%= (!customTabsActivePath || customTabsActivePath === '/admin/' + modelName)
                 ? 'border-blue-500 text-blue-600 bg-blue-50'
                 : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50' %>">
  List
</a>

<% customTabs.forEach(tab => { %>
  <a href="<%= tab.path %>"
     class="... <%= customTabsActivePath === tab.path
                   ? 'border-blue-500 text-blue-600 bg-blue-50'
                   : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50' %>">
    <i class="<%= tab.icon || 'fas fa-layer-group' %>"></i>
    <span><%= tab.name %></span>
  </a>
<% }); %>
```

---

## Middleware recap

The admin router applies the following middleware automatically:

1. `restrictTo(["ADMIN"])` – ensures the user is an admin.
2. `routeRegistry.getEnabledRoutes()` – populates `req.routes` and `req.baseUrl`.
3. `adminCrudGenerator` – populates `customTabs` + `customTabsActivePath` for list pages.  
   You must do the same when rendering your own tab pages.

---

## Worked example: Product Stock Transfer

Files involved:

| File                                   | Responsibility                                      |
|----------------------------------------|-----------------------------------------------------|
| `routes/admin.js`                      | Registers the custom tab and routes.                |
| `controllers/stockTransfer.js`         | Implements GET/POST handlers.                       |
| `views/admin/product-stock-transfer.ejs` | Page UI (form, tables, scripts).                    |
| `models/stock_transfer.js`             | Persistence model for transfer history.             |

These illustrate the complete flow, and you can copy the pattern for additional tabs (e.g. analytics dashboards, bulk import tools, reports).

---

## Common pitfalls

| Issue | Fix |
|-------|-----|
| Tab appears but clicking it shows 404 | Ensure the route path registered in `addCustomTab` matches the GET route you added. |
| Tab strip missing entirely | Confirm `routeRegistry.addCustomTab` runs before the first request (e.g. immediately after the CRUD route registration). |
| Sidebar missing on custom page | Make sure the controller passes `routes: req.routes` into `res.render`. |
| Icon not rendering | Use a valid Font Awesome class (e.g. `fas fa-cog`). |

---

## Extending further

- Tabs aren’t limited to server-rendered pages—feel free to embed React/Vue apps, charts, or integrated reports.
- Tabs can also serve as shortcuts to existing list filters (e.g. “Pending Orders”) by pointing to a filtered URL.
- Combine with `routeRegistry.addSubMenu` if you want matching sidebar links.

Happy building! Let the team know if you have ideas to improve the tab system further. 🚀

