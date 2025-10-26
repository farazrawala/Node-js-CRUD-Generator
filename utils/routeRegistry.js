/**
 * Dynamic Route Registry
 * Manages all admin routes dynamically
 */

class RouteRegistry {
  constructor() {
    this.routes = new Map();
    this.routeConfig = {};
    
    // Initialize default routes
    const defaultRoutes = {
      users: {
        name: 'Users',
        icon: 'fas fa-users',
        path: '/admin/users',
        description: 'Manage user accounts',
        order: 1,
        enabled: true
      },
      products: {
        name: 'Products',
        icon: 'fas fa-box',
        path: '/admin/products',
        description: 'Manage product catalog',
        order: 2,
        enabled: true,
        subMenus: [
          {
            name: 'Product List',
            icon: 'fas fa-list',
            path: '/admin/products',
            description: 'View all products'
          },
          {
            name: 'Product Complaints',
            icon: 'fas fa-exclamation-triangle',
            path: '/admin/products/complaints',
            description: 'Manage product-related complaints'
          },
          {
            name: 'Add Product',
            icon: 'fas fa-plus',
            path: '/admin/products/create',
            description: 'Add new product'
          }
        ]
      },
      blogs: {
        name: 'Blogs',
        icon: 'fas fa-blog',
        path: '/admin/blogs',
        description: 'Manage blog posts',
        order: 3,
        enabled: true
      },
      orders: {
        name: 'Orders',
        icon: 'fas fa-shopping-cart',
        path: '/admin/orders',
        description: 'Manage customer orders',
        order: 4,
        enabled: true
      },
      categories: {
        name: 'Categories',
        icon: 'fas fa-tags',
        path: '/admin/categories',
        description: 'Manage product categories',
        order: 5,
        enabled: true
      },
      complain: {
        name: 'Complaints',
        icon: 'fas fa-exclamation-triangle',
        path: '/admin/complain',
        description: 'Manage customer complaints',
        order: 6,
        enabled: true
      },
      company: {
        name: 'Company',
        icon: 'fas fa-building',
        path: '/admin/company',
        description: 'Manage Companies',
        order: 7,
        enabled: true
      },
      warehouse: {
        name: 'Warehouses',
        icon: 'fas fa-warehouse',
        path: '/admin/warehouse',
        description: 'Manage warehouses and inventory',
        order: 8,
        enabled: true
      },
      integration: {
        name: 'Integrations',
        icon: 'fas fa-cog',
        path: '/admin/integration',
        description: 'Manage integrations',
        order: 9,
        enabled: true
      }
    };
    
    // Add default routes to both routeConfig and routes Map
    Object.entries(defaultRoutes).forEach(([key, config]) => {
      this.routeConfig[key] = config;
      this.routes.set(key, config);
    });
  }

  /**
   * Register a new route
   */
  registerRoute(key, config) {
    const routeConfig = {
      name: config.name || this.generateName(key),
      icon: config.icon || 'fas fa-cog',
      path: config.path || `/admin/${key}`,
      description: config.description || `Manage ${key}`,
      order: config.order || this.getNextOrder(),
      enabled: config.enabled !== false,
      crudController: config.crudController,
      customRoutes: config.customRoutes || [],
      subMenus: config.subMenus || []
    };

    this.routes.set(key, routeConfig);
    this.routeConfig[key] = routeConfig;
    
    console.log(`📝 Registered route: ${key} -> ${routeConfig.path}`);
    return routeConfig;
  }

  /**
   * Get all enabled routes sorted by order
   */
  getEnabledRoutes() {
    return Array.from(this.routes.values())
      .filter(route => route.enabled)
      .sort((a, b) => a.order - b.order);
  }

  /**
   * Get all routes (including disabled)
   */
  getAllRoutes() {
    return Array.from(this.routes.values())
      .sort((a, b) => a.order - b.order);
  }

  /**
   * Get route by key
   */
  getRoute(key) {
    return this.routes.get(key);
  }

  /**
   * Update route configuration
   */
  updateRoute(key, updates) {
    const route = this.routes.get(key);
    if (route) {
      Object.assign(route, updates);
      this.routeConfig[key] = route;
      // console.log(`📝 Updated route: ${key}`);
      return route;
    }
    return null;
  }

  /**
   * Enable/disable route
   */
  toggleRoute(key, enabled) {
    const route = this.routes.get(key);
    if (route) {
      route.enabled = enabled;
      console.log(`📝 ${enabled ? 'Enabled' : 'Disabled'} route: ${key}`);
      return route;
    }
    return null;
  }

  /**
   * Delete route
   */
  deleteRoute(key) {
    const deleted = this.routes.delete(key);
    delete this.routeConfig[key];
    if (deleted) {
      console.log(`📝 Deleted route: ${key}`);
    }
    return deleted;
  }

  /**
   * Generate route name from key
   */
  generateName(key) {
    return key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' ');
  }

  /**
   * Get next order number
   */
  getNextOrder() {
    const routes = Array.from(this.routes.values());
    return routes.length > 0 ? Math.max(...routes.map(r => r.order)) + 1 : 1;
  }

  /**
   * Reorder routes
   */
  reorderRoutes(orderedKeys) {
    orderedKeys.forEach((key, index) => {
      const route = this.routes.get(key);
      if (route) {
        route.order = index + 1;
      }
    });
    console.log(`📝 Reordered routes`);
  }

  /**
   * Add sub-menu to existing route
   */
  addSubMenu(routeKey, subMenu) {
    const route = this.routes.get(routeKey);
    if (route) {
      if (!route.subMenus) {
        route.subMenus = [];
      }
      route.subMenus.push(subMenu);
      console.log(`📝 Added sub-menu "${subMenu.name}" to route "${routeKey}"`);
      return route;
    }
    return null;
  }

  /**
   * Remove sub-menu from route
   */
  removeSubMenu(routeKey, subMenuName) {
    const route = this.routes.get(routeKey);
    if (route && route.subMenus) {
      route.subMenus = route.subMenus.filter(sub => sub.name !== subMenuName);
      console.log(`📝 Removed sub-menu "${subMenuName}" from route "${routeKey}"`);
      return route;
    }
    return null;
  }

  /**
   * Get routes with sub-menus
   */
  getRoutesWithSubMenus() {
    return Array.from(this.routes.values())
      .filter(route => route.enabled && route.subMenus && route.subMenus.length > 0)
      .sort((a, b) => a.order - b.order);
  }

  /**
   * Get route statistics
   */
  getStats() {
    const routes = Array.from(this.routes.values());
    const routesWithSubMenus = routes.filter(r => r.subMenus && r.subMenus.length > 0);
    const totalSubMenus = routes.reduce((total, route) => {
      return total + (route.subMenus ? route.subMenus.length : 0);
    }, 0);
    
    return {
      total: routes.length,
      enabled: routes.filter(r => r.enabled).length,
      disabled: routes.filter(r => !r.enabled).length,
      withSubMenus: routesWithSubMenus.length,
      totalSubMenus: totalSubMenus
    };
  }

  /**
   * Export route configuration
   */
  exportConfig() {
    return {
      routes: Object.fromEntries(this.routes),
      stats: this.getStats(),
      exportedAt: new Date().toISOString()
    };
  }

  /**
   * Import route configuration
   */
  importConfig(config) {
    if (config.routes) {
      Object.entries(config.routes).forEach(([key, routeConfig]) => {
        this.routes.set(key, routeConfig);
        this.routeConfig[key] = routeConfig;
      });
      console.log(`📝 Imported ${Object.keys(config.routes).length} routes`);
    }
  }
}

// Create singleton instance
const routeRegistry = new RouteRegistry();

module.exports = routeRegistry;
