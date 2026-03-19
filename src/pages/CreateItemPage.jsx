import { useEffect, useMemo, useRef, useState } from "react";

import {
  buildQueryString,
  getActorHeaders,
  getAuthUserRole,
  getFetchCredentials,
  loadCategoriesFromStorage,
  loadCategoryNamesFromStorage,
  parsePagedResponse,
  readLocalStorage,
  resolveStoreId,
  safeParseList,
  writeLocalStorage,
} from "../utils/common.js";

const STORES_STORAGE_KEY = "pos.stores.v1";

function toNumberOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toIntOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function extractStoresList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.stores)) return payload.stores;
  if (Array.isArray(payload?.data?.stores)) return payload.data.stores;
  return [];
}

function toUiStore(apiStore) {
  if (!apiStore || typeof apiStore !== "object") return null;
  const id =
    apiStore.id ??
    apiStore._id ??
    apiStore.storeId ??
    apiStore.uuid ??
    (apiStore.name ? `name:${apiStore.name}` : null);
  if (!id) return null;
  return { id: String(id), name: String(apiStore.name ?? "") };
}

function resolveImageUrl(apiBaseUrl, value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^(https?:|data:|blob:)/i.test(raw)) return raw;
  const base = String(apiBaseUrl || "").replace(/\/$/, "");
  if (!base) return raw;
  return raw.startsWith("/") ? `${base}${raw}` : `${base}/${raw}`;
}

export default function CreateItemPage({
  apiBaseUrl,
  authToken,
  authUser,
  itemId,
  onCancel,
  onSaved,
}) {
  const didAutoSkuRef = useRef(false);
  const imageObjectUrlRef = useRef("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [isForSale, setIsForSale] = useState(true);
  const [soldBy, setSoldBy] = useState("each");
  const [price, setPrice] = useState("");
  const [cost, setCost] = useState("");
  const [sku, setSku] = useState("");
  const [barcode, setBarcode] = useState("");
  const [storeId, setStoreId] = useState(() => resolveStoreId(authUser));
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [imageFile, setImageFile] = useState(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState("");
  const [existingImageUrl, setExistingImageUrl] = useState("");

  // Inventory (intentionally excludes "Composite item", Variants, and POS representation sections)
  const [trackStock, setTrackStock] = useState(false);
  const [inStock, setInStock] = useState("");

  const authRole = useMemo(() => getAuthUserRole(authUser), [authUser]);
  const canPickStore = authRole === "admin" || authRole === "owner";
  const assignedStoreId = useMemo(() => resolveStoreId(authUser), [authUser]);

  const [stores, setStores] = useState(() => {
    return safeParseList(readLocalStorage(STORES_STORAGE_KEY, ""))
      .map(toUiStore)
      .filter(Boolean);
  });
  const [isStoresLoading, setIsStoresLoading] = useState(false);

  const categories = useMemo(() => {
    const unique = new Set();
    for (const name of loadCategoryNamesFromStorage()) unique.add(name);
    if (category) unique.add(category);
    return Array.from(unique).filter(Boolean).sort();
  }, [category]);

  const categoryId = useMemo(() => {
    const selected = String(category || "").trim();
    if (!selected) return null;

    const list = loadCategoriesFromStorage();
    const match = list.find((c) => c?.name === selected);
    return match?.id ?? null;
  }, [category]);

  const storeOptions = useMemo(() => {
    const map = new Map();
    for (const s of stores) {
      if (!s?.id) continue;
      map.set(String(s.id), { id: String(s.id), name: String(s.name ?? "") });
    }

    const active = String(storeId || "").trim();
    if (active && !map.has(active)) {
      map.set(active, { id: active, name: active });
    }

    return Array.from(map.values()).sort((a, b) =>
      String(a.name || a.id).localeCompare(String(b.name || b.id), undefined, {
        sensitivity: "base",
      }),
    );
  }, [storeId, stores]);

  function clearImageObjectUrl() {
    if (!imageObjectUrlRef.current) return;
    URL.revokeObjectURL(imageObjectUrlRef.current);
    imageObjectUrlRef.current = "";
  }

  function getAuthHeaders({ includeJsonContentType = true } = {}) {
    const headers = {};
    if (includeJsonContentType) headers["Content-Type"] = "application/json";
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    return { ...headers, ...getActorHeaders(authUser) };
  }

  async function readJsonSafely(response) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  async function apiRequest(path, { method = "GET", body } = {}) {
    const isFormData = typeof FormData !== "undefined" && body instanceof FormData;
    const response = await fetch(`${apiBaseUrl}${path}`, {
      method,
      credentials: getFetchCredentials(),
      headers: getAuthHeaders({ includeJsonContentType: !isFormData }),
      body: body ? (isFormData ? body : JSON.stringify(body)) : undefined,
    });

    const payload = await readJsonSafely(response);
    if (!response.ok) {
      const apiMessage =
        (payload && (payload.message || payload.error)) ||
        `Request failed (HTTP ${response.status}).`;
      throw new Error(String(apiMessage));
    }
    return payload;
  }

  useEffect(() => {
    return () => {
      clearImageObjectUrl();
    };
  }, []);

  useEffect(() => {
    writeLocalStorage(STORES_STORAGE_KEY, JSON.stringify(stores));
  }, [stores]);

  useEffect(() => {
    if (itemId) return;
    if (storeId) return;
    if (!assignedStoreId) return;
    setStoreId(assignedStoreId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignedStoreId, itemId]);

  useEffect(() => {
    if (!apiBaseUrl) return;
    let cancelled = false;

    async function loadStores() {
      setIsStoresLoading(true);
      try {
        const qs = buildQueryString({ page: 1, limit: 200 });
        const payload = await apiRequest(`/stores${qs}`);
        const paged = parsePagedResponse(payload, { page: 1, limit: 200 });
        const apiStores = extractStoresList({ ...payload, data: paged.data });
        const ui = apiStores.map(toUiStore).filter(Boolean);
        if (!cancelled && ui.length) setStores(ui);
      } catch {
        // optional: item create/edit can still work without stores list (if backend assigns store)
      } finally {
        if (!cancelled) setIsStoresLoading(false);
      }
    }

    loadStores();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBaseUrl, authToken]);

  useEffect(() => {
    if (itemId) return;
    if (storeId) return;
    if (assignedStoreId) return;
    if (storeOptions.length !== 1) return;
    setStoreId(storeOptions[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignedStoreId, itemId, storeOptions.length]);

  function extractSku(payload) {
    if (payload == null) return null;
    if (typeof payload === "string" || typeof payload === "number")
      return String(payload);
    if (typeof payload !== "object") return null;

    const skuValue =
      payload.sku ??
      payload.nextSku ??
      payload.next_sku ??
      payload?.data?.sku ??
      payload?.data?.nextSku ??
      payload?.data?.next_sku ??
      payload?.data ??
      null;

    if (skuValue == null) return null;
    if (typeof skuValue === "string" || typeof skuValue === "number")
      return String(skuValue);
    return null;
  }

  async function generateSku() {
    if (!apiBaseUrl) {
      setError("API base URL is not configured.");
      return;
    }

    const trimmed = sku.trim();
    if (trimmed) {
      const ok = window.confirm(
        "Generate a new SKU and replace the current one?",
      );
      if (!ok) return;
    }

    setError("");
    try {
      const payload = await apiRequest("/items/next-sku");
      const next = extractSku(payload);
      if (!next) throw new Error("Invalid SKU response from server.");
      setSku(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to generate SKU.");
    }
  }

  useEffect(() => {
    if (!apiBaseUrl) return;
    if (itemId) return;
    if (didAutoSkuRef.current) return;
    if (sku.trim()) return;

    didAutoSkuRef.current = true;
    generateSku();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBaseUrl, authToken, itemId]);

  useEffect(() => {
    if (!apiBaseUrl) return;
    if (!itemId) return;

    let cancelled = false;
    async function loadItem() {
      setIsLoading(true);
      setError("");
      try {
        const payload = await apiRequest(
          `/items/${encodeURIComponent(itemId)}`,
        );
        const data = payload?.data ?? payload?.item ?? payload;
        if (!data || typeof data !== "object")
          throw new Error("Invalid item payload.");

        if (cancelled) return;
        setName(String(data.name ?? ""));
        const categoryField = data.category ?? null;
        const loadedCategory =
          categoryField && typeof categoryField === "object"
            ? String(categoryField.name ?? "").trim()
            : String(
                data.categoryName ?? data.category_name ?? categoryField ?? "",
              ).trim();
        const loadedCategoryId =
          (categoryField && typeof categoryField === "object"
            ? categoryField.id ?? categoryField._id ?? null
            : null) ??
          data.categoryId ??
          data.category_id ??
          data.categoryID ??
          null;

        if (!loadedCategory && loadedCategoryId) {
          const fromStorage = loadCategoriesFromStorage().find(
            (c) => c?.id === String(loadedCategoryId),
          );
          setCategory(String(fromStorage?.name ?? ""));
        } else {
          setCategory(loadedCategory);
        }
        setDescription(String(data.description ?? ""));
        setIsForSale(Boolean(data.isForSale ?? data.is_for_sale ?? true));
        setSoldBy(String(data.soldBy ?? data.sold_by ?? "each"));
        setPrice(data.price == null ? "" : String(data.price));
        setCost(data.cost == null ? "" : String(data.cost));
        setSku(String(data.sku ?? ""));
        setBarcode(String(data.barcode ?? ""));
        const loadedImageUrl = resolveImageUrl(
          apiBaseUrl,
          data.imageUrl ?? data.image_url ?? data.image?.url ?? "",
        );
        clearImageObjectUrl();
        setImageFile(null);
        setExistingImageUrl(loadedImageUrl);
        setImagePreviewUrl(loadedImageUrl);

        const loadedStoreIdRaw =
          data.storeId ??
          data.store_id ??
          data.assignedStoreId ??
          data.assigned_store_id ??
          data.store?.id ??
          data.store?._id ??
          data.store?.storeId ??
          "";
        const loadedStoreId =
          typeof loadedStoreIdRaw === "string" || typeof loadedStoreIdRaw === "number"
            ? String(loadedStoreIdRaw)
            : "";
        if (loadedStoreId) setStoreId(loadedStoreId);

        const track = Boolean(data.trackStock ?? data.track_stock ?? true);
        setTrackStock(track);
        setInStock(data.inStock == null ? "" : String(data.inStock));
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Failed to load item.");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    loadItem();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBaseUrl, authToken, itemId]);

  async function saveItem() {
    setError("");
    if (!apiBaseUrl) {
      setError("API base URL is not configured.");
      return;
    }
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }

    setIsSaving(true);
    try {
      const skuValue = sku.trim();
      const skuNumber = toIntOrNull(skuValue);
      const categoryName = String(category || "").trim();
      const resolvedStoreId = String(storeId || assignedStoreId || "").trim();
      if (!resolvedStoreId) {
        setError("Store is required.");
        return;
      }

      const formData = new FormData();
      formData.set("name", name.trim());
      formData.set(
        "category",
        categoryName ? JSON.stringify({ id: categoryId || null, name: categoryName }) : "",
      );
      formData.set("description", description || "");
      formData.set("isForSale", String(Boolean(isForSale)));
      formData.set("soldBy", soldBy);
      formData.set("price", price === "" ? "" : String(toNumberOrNull(price) ?? ""));
      formData.set("cost", cost === "" ? "" : String(toNumberOrNull(cost) ?? ""));
      formData.set("sku", String(skuNumber ?? (skuValue || "")));
      formData.set("barcode", barcode || "");
      formData.set("trackStock", String(Boolean(trackStock)));
      formData.set("storeId", resolvedStoreId);
      formData.set("inStock", trackStock ? String(toIntOrNull(inStock) ?? "") : "");
      if (imageFile) formData.set("image", imageFile);

      if (itemId) {
        await apiRequest(`/items/${encodeURIComponent(itemId)}`, {
          method: "PATCH",
          body: formData,
        });
      } else {
        await apiRequest("/items", { method: "POST", body: formData });
      }

      onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save item.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="page">
      <div className="pageHeader">
        <h1 className="pageTitle">{itemId ? "Edit item" : "Create item"}</h1>
        <div className="pageSubtitle">
          {isLoading ? "Loading…" : "Basic info and inventory"}
        </div>
      </div>

      <div className="createItemWrap">
        <section className="card" aria-label="Item details">
          <div className="cardHeader">
            <div className="cardTitle">Details</div>
            <div className="cardSubtitle">Name, category, pricing</div>
          </div>

          <div className="createItemBody">
            <div className="createItemGrid">
              <label className="field createItemField">
                <div className="fieldLabel">Name</div>
                <input
                  className="textInput"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Name"
                  disabled={isLoading || isSaving}
                />
              </label>

              <label className="field createItemField">
                <div className="fieldLabel">Category</div>
                <select
                  className="select"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  disabled={isLoading || isSaving}
                >
                  <option value="">No category</option>
                  {categories.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="field createItemField">
              <div className="fieldLabel">Store</div>
              <select
                className="select"
                value={storeId}
                onChange={(e) => {
                  setStoreId(e.target.value);
                  if (error) setError("");
                }}
                disabled={
                  isLoading ||
                  isSaving ||
                  isStoresLoading ||
                  (Boolean(assignedStoreId) && !canPickStore)
                }
              >
                <option value="">
                  {isStoresLoading ? "Loading stores..." : "Select store"}
                </option>
                {storeOptions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name || s.id}
                  </option>
                ))}
              </select>
            </label>

            <label className="field createItemField">
              <div className="fieldLabel">Description</div>
              <textarea
                className="textarea"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Description"
                rows={3}
                disabled={isLoading || isSaving}
              />
            </label>

            <div className="field createItemField">
              <div className="fieldLabel">Item image</div>
              <div className="createItemImageField">
                <div className="createItemImagePreview">
                  {imagePreviewUrl ? (
                    <img
                      className="createItemImagePreviewImg"
                      src={imagePreviewUrl}
                      alt={`${name.trim() || "Item"} preview`}
                    />
                  ) : (
                    <span className="createItemImagePlaceholder">No image selected</span>
                  )}
                </div>

                <div className="createItemImageControls">
                  <label className="btn btnGhost btnSmall createItemImageBtn">
                    <input
                      className="createItemImageInput"
                      type="file"
                      accept="image/*"
                      onChange={(e) => {
                        const nextFile = e.target.files?.[0] ?? null;
                        clearImageObjectUrl();
                        setImageFile(nextFile);
                        if (nextFile) {
                          const nextUrl = URL.createObjectURL(nextFile);
                          imageObjectUrlRef.current = nextUrl;
                          setImagePreviewUrl(nextUrl);
                        } else {
                          setImagePreviewUrl(existingImageUrl);
                        }
                      }}
                      disabled={isLoading || isSaving}
                    />
                    {imagePreviewUrl ? "Change image" : "Upload image"}
                  </label>

                  {imageFile ? (
                    <button
                      className="btn btnGhost btnSmall"
                      type="button"
                      onClick={() => {
                        clearImageObjectUrl();
                        setImageFile(null);
                        setImagePreviewUrl(existingImageUrl);
                      }}
                      disabled={isLoading || isSaving}
                    >
                      Clear
                    </button>
                  ) : null}

                  <div className="createItemImageMeta">
                    {imageFile
                      ? imageFile.name
                      : existingImageUrl
                        ? "Current image"
                        : "JPG, PNG, or WEBP"}
                  </div>
                </div>
              </div>
            </div>

            <label className="createItemCheck">
              <input
                type="checkbox"
                checked={isForSale}
                onChange={(e) => setIsForSale(e.target.checked)}
                disabled={isLoading || isSaving}
              />
              <span>The item is available for sale</span>
            </label>

            <div className="createItemSoldBy" aria-label="Sold by">
              <div className="fieldLabel">Sold by</div>
              <label className="radio">
                <input
                  type="radio"
                  name="soldBy"
                  value="each"
                  checked={soldBy === "each"}
                  onChange={(e) => setSoldBy(e.target.value)}
                  disabled={isLoading || isSaving}
                />
                <span>Each</span>
              </label>
              <label className="radio">
                <input
                  type="radio"
                  name="soldBy"
                  value="weight"
                  checked={soldBy === "weight"}
                  onChange={(e) => setSoldBy(e.target.value)}
                  disabled={isLoading || isSaving}
                />
                <span>Weight/Volume</span>
              </label>
            </div>

            <div className="createItemGrid">
              <label className="field createItemField">
                <div className="fieldLabel">Price</div>
                <input
                  className="textInput"
                  inputMode="decimal"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder="0.00"
                  disabled={isLoading || isSaving}
                />
              </label>

              <label className="field createItemField">
                <div className="fieldLabel">Cost</div>
                <input
                  className="textInput"
                  inputMode="decimal"
                  value={cost}
                  onChange={(e) => setCost(e.target.value)}
                  placeholder="0.00"
                  disabled={isLoading || isSaving}
                />
              </label>
            </div>

            <div className="createItemGrid">
              <label className="field createItemField">
                <div className="fieldLabel">SKU</div>
                <div className="inputWithAction">
                  <input
                    className="textInput"
                    value={sku}
                    onChange={(e) => setSku(e.target.value)}
                    placeholder="SKU"
                    disabled={isLoading || isSaving}
                  />
                </div>
              </label>

              <label className="field createItemField">
                <div className="fieldLabel">Barcode</div>
                <input
                  className="textInput"
                  value={barcode}
                  onChange={(e) => setBarcode(e.target.value)}
                  placeholder="Barcode"
                  disabled={isLoading || isSaving}
                />
              </label>
            </div>

            {error ? <div className="authError">{error}</div> : null}
          </div>

          <div className="cardActions">
            <button className="btn btnGhost" type="button" onClick={onCancel}>
              Cancel
            </button>
            <button
              className="btn btnPrimary"
              type="button"
              onClick={saveItem}
              disabled={isLoading || isSaving}
            >
              Save
            </button>
          </div>
        </section>

        <section className="card" aria-label="Inventory">
          <div className="cardHeader">
            <div className="cardTitle">Inventory</div>
            <div className="cardSubtitle">Stock tracking</div>
          </div>

          <div className="list">
            <div className="row">
              <div className="rowMain">
                <div className="rowTitle">Track stock</div>
                <div className="rowSubtitle">
                  Count inventory for this item.
                </div>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={trackStock}
                  onChange={(e) => setTrackStock(e.target.checked)}
                  disabled={isLoading || isSaving}
                />
                <span className="switchTrack" aria-hidden="true" />
              </label>
            </div>

            {trackStock ? (
              <div className="row">
                <div className="rowMain">
                  <div className="rowTitle">In stock</div>
                  <div className="rowSubtitle">Starting quantity.</div>
                </div>
                <input
                  className="pageInput"
                  inputMode="numeric"
                  value={inStock}
                  onChange={(e) => setInStock(e.target.value)}
                  aria-label="In stock"
                  disabled={isLoading || isSaving}
                />
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}
