function createParentByHandleStore() {
  /** @type {Map<string, { title: string, description: string, vendor: string, category: string, type: string, status: string }>} */
  const parentByHandle = new Map();

  const rememberParentRow = (handle, row) => {
    const { title, description, vendor, productCategory, type, status } = row;
    if (!title && !description && !vendor && !productCategory && !type && !status) {
      return;
    }

    parentByHandle.set(handle, {
      title: title || parentByHandle.get(handle)?.title || "",
      description: description || parentByHandle.get(handle)?.description || "",
      vendor: vendor || parentByHandle.get(handle)?.vendor || "",
      category:
        productCategory || parentByHandle.get(handle)?.category || "",
      type: type || parentByHandle.get(handle)?.type || "",
      status: status || parentByHandle.get(handle)?.status || "",
    });
  };

  const getParent = (handle) =>
    parentByHandle.get(handle) || {
      title: "",
      description: "",
      vendor: "",
      category: "",
      type: "",
      status: "",
    };

  return { parentByHandle, rememberParentRow, getParent };
}

module.exports = { createParentByHandleStore };
