import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  buildQueryString,
  getActorHeaders,
  getAuthUserRole,
  getFetchCredentials,
  getReportStoreId,
  parsePagedResponse,
  toNonNegativeInt,
  toPositiveInt,
} from "../utils/common.js";
import { makeStoreOptions, useStoresList } from "../utils/stores.js";

function extractItemsList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.data?.results)) return payload.data.results;
  return [];
}

function toUiItem(apiItem) {
  if (!apiItem || typeof apiItem !== "object") return null;
  const id =
    apiItem.id ??
    apiItem._id ??
    apiItem.itemId ??
    apiItem.uuid ??
    (apiItem.name ? `name:${apiItem.name}` : null);
  if (!id) return null;

  const inStockRaw = apiItem.inStock ?? apiItem.stock ?? apiItem.qty ?? null;
  const inStock =
    typeof inStockRaw === "number"
      ? inStockRaw
      : inStockRaw == null || inStockRaw === ""
        ? null
        : Number(inStockRaw);

  const trackStockRaw = apiItem.trackStock ?? apiItem.track_stock ?? null;
  const trackStock = trackStockRaw == null ? inStock != null : Boolean(trackStockRaw);

  const storeId =
    apiItem.storeId ??
    apiItem.store_id ??
    apiItem.assignedStoreId ??
    apiItem.assigned_store_id ??
    apiItem.store?.id ??
    apiItem.store?._id ??
    apiItem.store?.storeId ??
    "";

  const storeName =
    apiItem.storeName ??
    apiItem.store_name ??
    apiItem.store?.name ??
    apiItem.store?.storeName ??
    apiItem.store?.label ??
    "";

  return {
    id: String(id),
    name: String(apiItem.name ?? "").trim(),
    category: (() => {
      const raw = apiItem.category ?? apiItem.categoryName ?? apiItem.category_name ?? "";
      if (raw && typeof raw === "object") return String(raw.name ?? "").trim();
      return String(raw ?? "").trim();
    })(),
    storeId: String(storeId || ""),
    storeName: String(storeName || "").trim(),
    trackStock,
    inStock: Number.isFinite(inStock) ? inStock : null,
  };
}

export default function LowStockItemsPage({
  apiBaseUrl,
  authToken,
  authUser,
  searchQuery = "",
  lockedStoreId = "",
  hideStoreFilter = false,
}) {
  const authRole = useMemo(() => getAuthUserRole(authUser), [authUser]);
  const canPickStore = authRole === "admin" || authRole === "owner";
  const reportStoreId = useMemo(() => getReportStoreId(authUser), [authUser]);
  const lockedStoreIdValue = useMemo(() => String(lockedStoreId || "").trim(), [lockedStoreId]);

  const [storeId, setStoreId] = useState(() => lockedStoreIdValue || reportStoreId);
  const [threshold, setThreshold] = useState(10);

  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [pageInput, setPageInput] = useState("1");

  const [items, setItems] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSavingStock, setIsSavingStock] = useState(false);
  const [savingItemId, setSavingItemId] = useState("");
  const [stockDrafts, setStockDrafts] = useState({});
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const lastFetchId = useRef(0);

  const getAuthHeaders = useCallback(() => {
    const headers = { "Content-Type": "application/json" };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    return { ...headers, ...getActorHeaders(authUser) };
  }, [authToken, authUser]);

  const apiRequest = useCallback(
    async (path, { method = "GET", body } = {}) => {
      const url = `${apiBaseUrl}${path}`;
      const response = await fetch(url, {
        method,
        headers: getAuthHeaders(),
        credentials: getFetchCredentials(),
        body: body ? JSON.stringify(body) : undefined,
      });

      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (!response.ok) {
        const message =
          (payload && (payload.message || payload.error)) ||
          `Request failed (HTTP ${response.status}).`;
        throw new Error(String(message));
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
    if (canPickStore) return storeOptions;
    const active = String(storeId || "").trim();
    if (!active) return [];
    return storeOptions.filter((s) => String(s.id) === active);
  }, [canPickStore, storeId, storeOptions]);

  useEffect(() => {
    if (!lockedStoreIdValue) return;
    if (storeId === lockedStoreIdValue) return;
    setStoreId(lockedStoreIdValue);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lockedStoreIdValue]);

  useEffect(() => {
    if (!apiBaseUrl) return;
    const fetchId = ++lastFetchId.current;
    setIsLoading(true);
    setError("");

    (async () => {
      try {
        const results = [];
        const apiLimit = 100;
        let currentPage = 1;
        const maxPages = 50;

        while (currentPage <= maxPages) {
          const qs = buildQueryString({
            page: currentPage,
            limit: apiLimit,
            storeId: storeId || undefined,
          });
          const payload = await apiRequest(`/items${qs}`);
          const parsed = parsePagedResponse(payload, { page: currentPage, limit: apiLimit });
          const pageData = extractItemsList({ ...payload, data: parsed.data });
          results.push(...pageData);
          if (!parsed.hasNext || pageData.length === 0) break;
          currentPage += 1;
        }

        const mapped = results.map(toUiItem).filter(Boolean);
        if (fetchId !== lastFetchId.current) return;
        setItems(mapped);
      } catch (e) {
        if (fetchId !== lastFetchId.current) return;
        setError(e instanceof Error ? e.message : "Failed to load low stock items.");
        setItems([]);
      } finally {
        if (fetchId === lastFetchId.current) setIsLoading(false);
      }
    })();
  }, [apiBaseUrl, apiRequest, storeId]);

  const updateStockDraft = useCallback((itemId, value) => {
    setStockDrafts((prev) => ({
      ...prev,
      [itemId]: value,
    }));
  }, []);

  const handleSaveStock = useCallback(
    async (item) => {
      if (!item?.id || isSavingStock) return;

      const rawValue =
        stockDrafts[item.id] ??
        (item.inStock == null ? "" : String(item.inStock));
      const trimmed = String(rawValue ?? "").trim();
      const nextStock = toNonNegativeInt(trimmed, -1);

      if (trimmed === "" || nextStock < 0) {
        setSuccess("");
        setError("Enter a valid stock value of 0 or higher.");
        return;
      }

      setIsSavingStock(true);
      setSavingItemId(item.id);
      setError("");
      setSuccess("");

      try {
        const payload = await apiRequest(`/items/${encodeURIComponent(item.id)}/stock`, {
          method: "PATCH",
          body: { inStock: nextStock },
        });

        const updatedPayload =
          (payload?.data && typeof payload.data === "object" ? payload.data : null) ??
          (payload?.item && typeof payload.item === "object" ? payload.item : null) ??
          (payload && typeof payload === "object" ? payload : null);
        const normalizedUpdated = toUiItem(updatedPayload);
        const nextItem = normalizedUpdated
          ? {
              ...item,
              ...normalizedUpdated,
              inStock:
                normalizedUpdated.inStock == null ? nextStock : normalizedUpdated.inStock,
              trackStock: true,
            }
          : {
              ...item,
              inStock: nextStock,
              trackStock: true,
            };

        setItems((prev) => prev.map((current) => (current.id === item.id ? nextItem : current)));
        setStockDrafts((prev) => ({
          ...prev,
          [item.id]: String(nextItem.inStock ?? nextStock),
        }));
        setSuccess(`Updated stock for ${item.name || item.id}.`);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to update stock.");
      } finally {
        setIsSavingStock(false);
        setSavingItemId("");
      }
    },
    [apiRequest, isSavingStock, stockDrafts],
  );

  const lowStockItems = useMemo(() => {
    const t = toPositiveInt(threshold, 10);
    const q = String(searchQuery || "").trim().toLowerCase();

    return items
      .filter((it) => it?.trackStock && typeof it.inStock === "number" && it.inStock < t)
      .filter((it) => {
        if (!q) return true;
        const haystack = `${it.name ?? ""} ${it.category ?? ""} ${it.storeName ?? ""} ${it.storeId ?? ""}`
          .trim()
          .toLowerCase();
        return haystack.includes(q);
      })
      .sort((a, b) => (a.inStock ?? 0) - (b.inStock ?? 0) || a.name.localeCompare(b.name));
  }, [items, searchQuery, threshold]);

  const total = lowStockItems.length;
  const totalPages = Math.max(1, Math.ceil(total / Math.max(1, limit)));
  const canPrev = page > 1;
  const canNext = page < totalPages;

  const pageItems = useMemo(() => {
    const start = (page - 1) * limit;
    return lowStockItems.slice(start, start + limit);
  }, [limit, lowStockItems, page]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
    if (pageInput !== String(page)) setPageInput(String(page));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, totalPages]);

  useEffect(() => {
    setPage(1);
    setPageInput("1");
  }, [storeId, threshold, searchQuery]);

  return (
    <div className="page salesSummaryPage">
      <div className="salesSummaryHeaderBar" aria-label="Low Stock Items">
        <div className="salesSummaryHeaderTitle">Low Stock Items</div>
      </div>

      <div className="card salesSummaryFiltersCard">
        <div className="salesSummaryFilters">
          {hideStoreFilter || lockedStoreIdValue ? null : (
            <div className="salesSummaryFilterGroup">
              <select
                className="select"
                value={storeId}
                onChange={(e) => {
                  setStoreId(e.target.value);
                  if (error) setError("");
                }}
                aria-label="Store filter"
                disabled={isLoading || isStoresLoading || !canPickStore}
              >
                {canPickStore ? <option value="">All stores</option> : null}
                {!canPickStore && !storeId ? <option value="">No store assigned</option> : null}
                {visibleStoreOptions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name || s.id}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="salesSummaryFilterGroup">
            <select
              className="select"
              value={String(threshold)}
              onChange={(e) => setThreshold(toPositiveInt(e.target.value, threshold))}
              aria-label="Low stock threshold"
              disabled={isLoading}
            >
              <option value="5">Below 5</option>
              <option value="10">Below 10</option>
              <option value="20">Below 20</option>
            </select>
          </div>

          <div className="salesSummaryFilterGroup">
            <div className="salesSummaryHint">
              {isLoading ? "Loading…" : `${total} item(s) low stock`}
            </div>
          </div>
        </div>
      </div>

      {success ? <div className="authSuccess">{success}</div> : null}
      {error ? <div className="authError salesSummaryError">{error}</div> : null}

      <div className="card salesSummaryTableCard">
        <div className="tableWrap">
          <table className="table">
            <thead>
              <tr>
                <th className="colName">Item</th>
                <th className="colCategory">Category</th>
                <th className="colStore">Store</th>
                <th className="colStock">In stock</th>
              </tr>
            </thead>
            <tbody>
              {pageItems.length === 0 ? (
                <tr>
                  <td colSpan={4} className="usersEmpty">
                    {isLoading ? "Loading…" : "No low stock items found."}
                  </td>
                </tr>
              ) : (
                pageItems.map((it) => (
                  <tr key={it.id}>
                    <td className="colName">{it.name || it.id}</td>
                    <td className="colCategory">
                      <span className="cellSelect">{it.category || "—"}</span>
                    </td>
                    <td className="colStore">
                      <span className="cellSelect">{it.storeName || it.storeId || "—"}</span>
                    </td>
                    <td className="colStock">
                      <div className="lowStockEditor">
                        <input
                          className="pageInput lowStockStockInput"
                          type="number"
                          min="0"
                          step="1"
                          value={
                            stockDrafts[it.id] ??
                            (it.inStock == null ? "" : String(it.inStock))
                          }
                          onChange={(e) => {
                            updateStockDraft(it.id, e.target.value);
                            if (error) setError("");
                            if (success) setSuccess("");
                          }}
                          onKeyDown={(e) => {
                            if (e.key !== "Enter") return;
                            void handleSaveStock(it);
                          }}
                          aria-label={`In stock for ${it.name || it.id}`}
                          disabled={isLoading || isSavingStock}
                        />
                        <button
                          className="btn btnGhost btnSmall lowStockSaveBtn"
                          type="button"
                          onClick={() => {
                            void handleSaveStock(it);
                          }}
                          disabled={isLoading || isSavingStock}
                        >
                          {savingItemId === it.id ? "Saving..." : "Save"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="salesSummaryPager" aria-label="Pagination">
          <div className="pagerButtons" aria-label="Page controls">
            <button
              className="pagerBtn"
              type="button"
              aria-label="Previous page"
              disabled={!canPrev || isLoading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              {"<"}
            </button>
            <button
              className="pagerBtn"
              type="button"
              aria-label="Next page"
              disabled={!canNext || isLoading}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              {">"}
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
                const clamped = Math.min(Math.max(1, next), totalPages);
                setPage(clamped);
              }}
              onBlur={() => {
                const next = toPositiveInt(pageInput, page);
                const clamped = Math.min(Math.max(1, next), totalPages);
                setPageInput(String(clamped));
                setPage(clamped);
              }}
              aria-label="Page number"
              disabled={isLoading}
            />
            <span>of {totalPages}</span>
          </div>

          <div className="pagerMeta">
            <span>Rows per page:</span>
            <select
              className="select selectSmall"
              value={String(limit)}
              onChange={(e) => {
                setLimit(toPositiveInt(e.target.value, limit));
                setPage(1);
                setPageInput("1");
              }}
              disabled={isLoading}
              aria-label="Rows per page"
            >
              <option value="10">10</option>
              <option value="20">20</option>
              <option value="50">50</option>
              <option value="100">100</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}
