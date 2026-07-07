function createImagesByHandleStore() {
  /** @type {Map<string, string[]>} */
  const imagesByHandle = new Map();

  const rememberHandleImage = (handle, url) => {
    const imageUrl = String(url || "").trim();
    if (!handle || !imageUrl || !/^https?:\/\//i.test(imageUrl)) return;
    if (!imagesByHandle.has(handle)) imagesByHandle.set(handle, []);
    const list = imagesByHandle.get(handle);
    if (!list.includes(imageUrl)) list.push(imageUrl);
  };

  return { imagesByHandle, rememberHandleImage };
}

module.exports = { createImagesByHandleStore };
