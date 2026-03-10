import { useCallback, useEffect, useMemo, useState } from "react";

import {
  buildQueryString,
  compareValues,
  getActorHeaders,
  getAuthUserRole,
  getFetchCredentials,
  getReportStoreId,
  loadCategoriesFromStorage,
  loadCategoryNamesFromStorage,
  parsePagedResponse,
  toPositiveInt,
} from "../utils/common.js";
import { makeStoreOptions, useStoresList } from "../utils/stores.js";

const moneyFormatter = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatMoney(value) {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) return "—";
  return moneyFormatter.format(numberValue);
}

function formatMarginPercent({ price, cost }) {
  const priceNumber = typeof price === "number" ? price : Number(price);
  const costNumber = typeof cost === "number" ? cost : Number(cost);

  if (!Number.isFinite(priceNumber) || priceNumber <= 0) return "—";
  if (!Number.isFinite(costNumber)) return "—";

  const margin = ((priceNumber - costNumber) / priceNumber) * 100;
  return `${margin.toFixed(2)}%`;
}

function getSortValue(item, key) {
  switch (key) {
    case "name":
      return item.name ?? "";
    case "category":
      return item.category ?? "";
    case "store":
      return item.storeName ?? item.storeId ?? "";
    case "price":
      return item.price;
    case "cost":
      return item.cost;
    case "margin": {
      const price = typeof item.price === "number" ? item.price : Number(item.price);
      const cost = typeof item.cost === "number" ? item.cost : Number(item.cost);
      if (!Number.isFinite(price) || price <= 0) return null;
      if (!Number.isFinite(cost)) return null;
      return (price - cost) / price;
    }
    case "inStock":
      return item.inStock;
    default:
      return null;
  }
}

function extractItemsList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.data?.results)) return payload.data.results;
  return [];
}

function toUiItem(apiItem, categoryNameById) {
  if (!apiItem || typeof apiItem !== "object") return null;

  const id =
    apiItem.id ??
    apiItem._id ??
    apiItem.itemId ??
    apiItem.uuid ??
    (apiItem.name ? `name:${apiItem.name}` : null);
  if (!id) return null;

  const price = apiItem.price ?? null;
  const cost = apiItem.cost ?? null;
  const inStock = apiItem.inStock ?? apiItem.stock ?? apiItem.qty ?? null;

  const rawCategory = apiItem.category ?? apiItem.categoryName ?? apiItem.category_name ?? "";
  let category = "";
  let categoryId = null;

  if (rawCategory && typeof rawCategory === "object") {
    category = String(rawCategory.name ?? "").trim();
    const rawId =
      rawCategory.id ?? rawCategory._id ?? rawCategory.categoryId ?? rawCategory.uuid ?? null;
    if (rawId != null) categoryId = String(rawId);
  } else {
    category = String(rawCategory ?? "").trim();
  }

  if (categoryId == null) {
    const rawId = apiItem.categoryId ?? apiItem.category_id ?? apiItem.categoryID ?? null;
    if (rawId != null) categoryId = String(rawId);
  }

  if (!category && categoryId && categoryNameById?.has(categoryId)) {
    category = categoryNameById.get(categoryId) || "";
  }

  const storeIdRaw =
    apiItem.storeId ??
    apiItem.store_id ??
    apiItem.assignedStoreId ??
    apiItem.assigned_store_id ??
    apiItem.store?.id ??
    apiItem.store?._id ??
    apiItem.store?.storeId ??
    "";
  const storeId =
    typeof storeIdRaw === "string" || typeof storeIdRaw === "number"
      ? String(storeIdRaw)
      : "";

  const storeNameRaw =
    apiItem.storeName ??
    apiItem.store_name ??
    apiItem.store?.name ??
    apiItem.store?.storeName ??
    apiItem.store?.label ??
    "";
  const storeName = String(storeNameRaw ?? "").trim();

  return {
    id: String(id),
    name: String(apiItem.name ?? ""),
    category,
    categoryId,
    storeId,
    storeName,
    price: typeof price === "number" ? price : price == null || price === "" ? null : Number(price),
    cost: typeof cost === "number" ? cost : cost == null || cost === "" ? null : Number(cost),
    inStock:
      typeof inStock === "number"
        ? inStock
        : inStock == null || inStock === ""
          ? null
          : Number(inStock),
  };
}

export default function ItemListPage({
  apiBaseUrl,
  authToken,
  authUser,
  onAddItem,
  onEditItem,
  searchQuery,
  readOnly = false,
  compact = false,
  storeIdFilter = "",
}) {
  const [items, setItems] = useState([]);
  const [category, setCategory] = useState("all");
  const [sort, setSort] = useState({ key: "name", direction: "asc" });
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const authRole = useMemo(() => getAuthUserRole(authUser), [authUser]);
  const canPickStore = authRole === "admin" || authRole === "owner";
  const reportStoreId = useMemo(() => getReportStoreId(authUser), [authUser]);
  const forcedStoreId = String(storeIdFilter || "").trim();
  const [storeId, setStoreId] = useState(() => forcedStoreId || reportStoreId);

  const showStore = !compact;
  const showCost = !compact;
  const showMargin = !compact;
  const showActions = !readOnly;

  const assignedStoreName = String(
    authUser?.storeName ??
      authUser?.store_name ??
      authUser?.store?.name ??
      authUser?.store?.storeName ??
      authUser?.store?.label ??
      "",
  ).trim();

  function isInAssignedStore(item) {
    if (canPickStore && !forcedStoreId) return true;

    const restrictionStoreId = forcedStoreId || reportStoreId;
    const restrictionStoreName = forcedStoreId
      ? String(storeNameById?.get?.(forcedStoreId) || "").trim()
      : assignedStoreName;

    if (!restrictionStoreId && !restrictionStoreName) return true;
    const itemStoreId = String(item?.storeId ?? "").trim();
    const itemStoreName = String(item?.storeName ?? "").trim();

    if (restrictionStoreId && itemStoreId && itemStoreId === restrictionStoreId) return true;
    if (
      restrictionStoreName &&
      itemStoreName &&
      itemStoreName.toLowerCase() === restrictionStoreName.toLowerCase()
    ) {
      return true;
    }
    return false;
  }

  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [total, setTotal] = useState(null);
  const [hasNext, setHasNext] = useState(false);
  const [hasPrev, setHasPrev] = useState(false);
  const totalPages = total ? Math.max(1, Math.ceil(total / limit)) : null;
  const [pageInput, setPageInput] = useState("1");

  const getAuthHeaders = useCallback(() => {
    const headers = { "Content-Type": "application/json" };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    return { ...headers, ...getActorHeaders(authUser) };
  }, [authToken, authUser]);

  const apiRequest = useCallback(
    async (path, { method = "GET", body } = {}) => {
      const response = await fetch(`${apiBaseUrl}${path}`, {
        method,
        credentials: getFetchCredentials(),
        headers: getAuthHeaders(),
        body: body ? JSON.stringify(body) : undefined,
      });

      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (!response.ok) {
        const apiMessage =
          (payload && (payload.message || payload.error)) ||
          `Request failed (HTTP ${response.status}).`;
        throw new Error(String(apiMessage));
      }
      return payload;
    },
    [apiBaseUrl, getAuthHeaders],
  );

  const { stores, isStoresLoading } = useStoresList({ apiBaseUrl, apiRequest });

  const storeOptions = useMemo(() => {
    return makeStoreOptions({ stores, activeStoreId: storeId });
  }, [storeId, stores]);

  const visibleStoreOptions = useMemo(() => {
    if (canPickStore && !forcedStoreId) return storeOptions;
    const active = String(storeId || "").trim();
    if (!active) return [];
    return storeOptions.filter((s) => String(s.id) === active);
  }, [canPickStore, forcedStoreId, storeId, storeOptions]);

  const storeNameById = useMemo(() => {
    const map = new Map();
    for (const option of storeOptions) {
      map.set(String(option.id), String(option.name || option.id));
    }
    return map;
  }, [storeOptions]);

  const activeStoreName = useMemo(() => {
    const key = String(storeId || "").trim();
    if (!key) return "";
    return String(storeNameById.get(key) || "").trim();
  }, [storeId, storeNameById]);

  useEffect(() => {
    if (forcedStoreId) {
      setStoreId(forcedStoreId);
      return;
    }

    if (!canPickStore) {
      setStoreId(reportStoreId);
      return;
    }

    if (authRole !== "admin" && reportStoreId && !storeId) {
      setStoreId(reportStoreId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authRole, canPickStore, forcedStoreId, reportStoreId]);

  const categories = useMemo(() => {
    const unique = new Set();
    for (const item of items) unique.add(item.category);
    for (const name of loadCategoryNamesFromStorage()) unique.add(name);
    return Array.from(unique).filter(Boolean).sort();
  }, [items]);

  const categoryNameById = useMemo(() => {
    const map = new Map();
    for (const c of loadCategoriesFromStorage()) {
      if (!c?.id || !c?.name) continue;
      map.set(String(c.id), String(c.name));
    }
    return map;
  }, []);

  const visibleItems = useMemo(() => {
    let list = items;

    if (storeId) {
      const activeId = String(storeId || "").trim();
      const activeName = activeStoreName.trim().toLowerCase();

      list = list.filter((item) => {
        const itemStoreId = String(item?.storeId ?? "").trim();
        if (itemStoreId && itemStoreId === activeId) return true;

        if (!itemStoreId && activeName) {
          const itemStoreName = String(item?.storeName ?? "").trim().toLowerCase();
          return Boolean(itemStoreName) && itemStoreName === activeName;
        }

        return false;
      });
    }
    if (category !== "all") list = list.filter((item) => item.category === category);

    const q = (searchQuery || "").trim().toLowerCase();
    if (!q) return list;

    return list.filter((item) => {
      const haystack = `${item?.name ?? ""} ${item?.category ?? ""} ${item?.storeName ?? ""}`
        .trim()
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [activeStoreName, category, items, searchQuery, storeId]);

  const sortedItems = useMemo(() => {
    const factor = sort.direction === "asc" ? 1 : -1;

    return [...visibleItems].sort((a, b) => {
      const primary = compareValues(getSortValue(a, sort.key), getSortValue(b, sort.key));
      if (primary !== 0) return primary * factor;

      const byName = compareValues(a.name ?? "", b.name ?? "");
      if (byName !== 0) return byName;
      return compareValues(a.id ?? "", b.id ?? "");
    });
  }, [visibleItems, sort.direction, sort.key]);

  useEffect(() => {
    if (!compact) return;
    if (sort.key === "store" || sort.key === "cost" || sort.key === "margin") {
      setSort({ key: "name", direction: "asc" });
    }
  }, [compact, sort.key]);

  async function reloadItems() {
    if (!apiBaseUrl) return;
    setIsLoading(true);
    setError("");
    try {
      const qs = buildQueryString({
        page,
        limit,
        search: (searchQuery || "").trim() || undefined,
        storeId: storeId || undefined,
      });
      const payload = await apiRequest(`/items${qs}`);
      const paged = parsePagedResponse(payload, { page, limit });
      const apiItems = extractItemsList({ ...payload, data: paged.data });
      const mapped = apiItems.map((item) => toUiItem(item, categoryNameById)).filter(Boolean);
      setItems(forcedStoreId || !canPickStore ? mapped.filter(isInAssignedStore) : mapped);
      setTotal(paged.total ?? null);
      setHasNext(Boolean(paged.hasNext));
      setHasPrev(Boolean(paged.hasPrev));
      setPageInput(String(page));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load items.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    if (!apiBaseUrl) return;
    let cancelled = false;
    async function load() {
      if (cancelled) return;
      await reloadItems();
    }
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBaseUrl, authToken, page, limit, searchQuery, storeId]);

  useEffect(() => {
    if (page !== 1) setPage(1);
    if (pageInput !== "1") setPageInput("1");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);

  async function deleteItem(item) {
    const label = item?.name || "this item";
    const ok = window.confirm(`Delete ${label}? This cannot be undone.`);
    if (!ok) return;
    if (!apiBaseUrl) {
      setError("API base URL is not configured.");
      return;
    }

    setIsSaving(true);
    setError("");
    try {
      await apiRequest(`/items/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      await reloadItems();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete item.");
    } finally {
      setIsSaving(false);
    }
  }

  function toggleSort(key) {
    setSort((prev) => {
      if (prev.key === key) {
        return { key, direction: prev.direction === "asc" ? "desc" : "asc" };
      }
      return { key, direction: "asc" };
    });
  }

  function sortArrow(key) {
    if (sort.key !== key) return null;
    return sort.direction === "asc" ? "↑" : "↓";
  }

  function ariaSort(key) {
    if (sort.key !== key) return "none";
    return sort.direction === "asc" ? "ascending" : "descending";
  }

  const columnCount =
    4 +
    (showStore ? 1 : 0) +
    (showCost ? 1 : 0) +
    (showMargin ? 1 : 0) +
    (showActions ? 1 : 0);

  return (
    <div className="page">
      <div className="itemListCard">
        <div className="itemListToolbar">
          {!readOnly ? (
            <button
              className="btn btnPrimary itemListAddBtn"
              type="button"
              onClick={() => onAddItem?.()}
              disabled={!onAddItem}
              title={!onAddItem ? "Not available" : undefined}
            >
              + Add item
            </button>
          ) : null}

          <div className="itemListToolbarSpacer" />

          <label className="field">
            <div className="fieldLabel">Category</div>
            <select
              className="select"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="all">All categories</option>
              {categories.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
          </label>

          {showStore ? (
            <label className="field">
              <div className="fieldLabel">Store</div>
              <select
                className="select"
                value={storeId}
                onChange={(e) => {
                  setStoreId(e.target.value);
                  if (page !== 1) setPage(1);
                  if (pageInput !== "1") setPageInput("1");
                  if (error) setError("");
                }}
                aria-label="Store filter"
                disabled={
                  isLoading ||
                  isStoresLoading ||
                  Boolean(forcedStoreId) ||
                  !canPickStore ||
                  compact
                }
              >
                {canPickStore && !forcedStoreId ? <option value="">All stores</option> : null}
                {!canPickStore && !storeId ? (
                  <option value="">No store assigned</option>
                ) : null}
                {visibleStoreOptions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name || s.id}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>

        {error ? (
          <div className="authError" style={{ margin: "0 16px 12px" }}>
            {error}
          </div>
        ) : null}

        <div className="tableWrap">
          <table className="table" aria-label="Item list">
            <thead>
              <tr>
                <th className="colName" aria-sort={ariaSort("name")}>
                  <button
                    type="button"
                    className="thSortBtn"
                    onClick={() => toggleSort("name")}
                  >
                    Item name <span className="sortArrow">{sortArrow("name")}</span>
                  </button>
                </th>
                <th className="colCategory" aria-sort={ariaSort("category")}>
                  <button
                    type="button"
                    className="thSortBtn"
                    onClick={() => toggleSort("category")}
                  >
                    Category <span className="sortArrow">{sortArrow("category")}</span>
                  </button>
                </th>
                {showStore ? (
                  <th className="colStore" aria-sort={ariaSort("store")}>
                    <button
                      type="button"
                      className="thSortBtn"
                      onClick={() => toggleSort("store")}
                    >
                      Store <span className="sortArrow">{sortArrow("store")}</span>
                    </button>
                  </th>
                ) : null}
                <th className="colMoney" aria-sort={ariaSort("price")}>
                  <button
                    type="button"
                    className="thSortBtn thSortBtnRight"
                    onClick={() => toggleSort("price")}
                  >
                    Price <span className="sortArrow">{sortArrow("price")}</span>
                  </button>
                </th>
                {showCost ? (
                  <th className="colMoney" aria-sort={ariaSort("cost")}>
                    <button
                      type="button"
                      className="thSortBtn thSortBtnRight"
                      onClick={() => toggleSort("cost")}
                    >
                      Cost <span className="sortArrow">{sortArrow("cost")}</span>
                    </button>
                  </th>
                ) : null}
                {showMargin ? (
                  <th className="colMoney" aria-sort={ariaSort("margin")}>
                    <button
                      type="button"
                      className="thSortBtn thSortBtnRight"
                      onClick={() => toggleSort("margin")}
                    >
                      Margin <span className="sortArrow">{sortArrow("margin")}</span>
                    </button>
                  </th>
                ) : null}
                <th className="colStock" aria-sort={ariaSort("inStock")}>
                  <button
                    type="button"
                    className="thSortBtn thSortBtnRight"
                    onClick={() => toggleSort("inStock")}
                  >
                    In stock <span className="sortArrow">{sortArrow("inStock")}</span>
                  </button>
                </th>
                {showActions ? <th className="colActions" aria-label="Actions" /> : null}
              </tr>
            </thead>
            <tbody>
              {sortedItems.length === 0 ? (
                <tr>
                  <td colSpan={columnCount} className="usersEmpty">
                    {isLoading ? "Loading…" : "No items found."}
                  </td>
                </tr>
              ) : (
                sortedItems.map((item) => (
                  <tr key={item.id}>
                    <td className="colName">{item.name}</td>
                    <td className="colCategory">
                      <span className="cellSelect">{item.category || "—"}</span>
                    </td>
                    {showStore ? (
                      <td className="colStore">
                      <span className="cellSelect">
                        {item.storeName || item.storeId || "—"}
                      </span>
                      </td>
                    ) : null}
                    <td className="colMoney">{formatMoney(item.price)}</td>
                    {showCost ? <td className="colMoney">{formatMoney(item.cost)}</td> : null}
                    {showMargin ? (
                      <td className="colMoney">{formatMarginPercent(item)}</td>
                    ) : null}
                    <td className="colStock">{item.inStock ?? "—"}</td>
                    {showActions ? (
                      <td className="colActions">
                        <div className="usersActions">
                          <button
                            className="btn btnGhost btnSmall"
                            type="button"
                            onClick={() => onEditItem?.(item.id)}
                            disabled={isSaving || !onEditItem}
                            title={!onEditItem ? "Not available" : undefined}
                          >
                            Edit
                          </button>
                          <button
                            className="btn btnGhost btnSmall btnDanger"
                            type="button"
                            onClick={() => deleteItem(item)}
                            disabled={isSaving}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="itemListFooter" aria-label="Pagination">
          <div className="pagerButtons" aria-label="Page controls">
            <button
              className="pagerBtn"
              type="button"
              aria-label="Previous page"
              disabled={!hasPrev || page <= 1 || isLoading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              ‹
            </button>
            <button
              className="pagerBtn"
              type="button"
              aria-label="Next page"
              disabled={!hasNext || isLoading}
              onClick={() => setPage((p) => p + 1)}
            >
              ›
            </button>
          </div>

          <div className="pagerMeta">
            <span>Page:</span>
            <input
              className="pageInput"
              type="text"
              value={pageInput}
              onChange={(e) => setPageInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                const next = toPositiveInt(pageInput, page);
                const clamped = totalPages ? Math.min(next, totalPages) : next;
                setPage(clamped);
              }}
              onBlur={() => {
                const next = toPositiveInt(pageInput, page);
                const clamped = totalPages ? Math.min(next, totalPages) : next;
                setPageInput(String(clamped));
                setPage(clamped);
              }}
              aria-label="Page number"
            />
            <span>of {totalPages ?? "—"}</span>
          </div>

          <div className="pagerMeta">
            <span>Rows per page:</span>
            <select
              className="select selectSmall"
              value={String(limit)}
              onChange={(e) => {
                const nextLimit = toPositiveInt(e.target.value, limit);
                setLimit(nextLimit);
                setPageInput("1");
                setPage(1);
              }}
              aria-label="Rows per page"
            >
              <option value="10">10</option>
              <option value="20">20</option>
              <option value="50">50</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}
