import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  buildQueryString,
  getActorHeaders,
  getAuthUserRole,
  getFetchCredentials,
  getReportStoreId,
  parsePagedResponse,
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
  if (!Number.isFinite(numberValue)) return "--";
  return moneyFormatter.format(numberValue);
}

function formatIsoDateInput(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function dateFromIsoDateInput(value) {
  const raw = String(value || "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  return new Date(y, m - 1, d);
}

function getLocalDayBounds(dateKey) {
  const base = dateFromIsoDateInput(dateKey);
  if (!(base instanceof Date) || Number.isNaN(base.getTime())) return null;
  const start = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, 0, 0, 0);
  const end = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1, 0, 0, 0, 0);
  return { start, end };
}

function normalizeNumber(value) {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function toPositiveInt(value, fallback) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  return i > 0 ? i : fallback;
}

function extractSalesList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.data?.results)) return payload.data.results;
  return [];
}

function getSaleCashierId(raw) {
  if (!raw || typeof raw !== "object") return "";
  const id =
    raw.cashierId ??
    raw.cashier_id ??
    raw.employeeId ??
    raw.employee_id ??
    raw.userId ??
    raw.user_id ??
    raw.createdBy ??
    raw.created_by ??
    raw.cashier?.id ??
    raw.cashier?._id ??
    raw.employee?.id ??
    raw.employee?._id ??
    raw.user?.id ??
    raw.user?._id ??
    null;
  return id == null ? "" : String(id);
}

function getSaleCreatedAt(raw) {
  if (!raw || typeof raw !== "object") return null;
  const createdAt = raw.createdAt ?? raw.created_at ?? raw.datetime ?? raw.date ?? null;
  if (!createdAt) return null;
  if (typeof createdAt === "string") {
    const trimmed = createdAt.trim();
    const looksIso =
      /^\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(
        trimmed,
      );
    if (!looksIso) return null;
  }
  const dt = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

function getSaleGrossSales(raw) {
  if (!raw || typeof raw !== "object") return null;
  const totals = raw.totals && typeof raw.totals === "object" ? raw.totals : {};
  const fromTotals =
    normalizeNumber(totals.subtotal) ??
    normalizeNumber(totals.gross) ??
    normalizeNumber(totals.totalBeforeDiscount) ??
    normalizeNumber(totals.total_before_discount) ??
    null;
  const fromRaw =
    normalizeNumber(raw.subtotal) ??
    normalizeNumber(raw.gross) ??
    normalizeNumber(raw.totalBeforeDiscount) ??
    normalizeNumber(raw.total_before_discount) ??
    null;

  const direct = fromTotals ?? fromRaw;
  if (direct != null) return direct;

  const rawItems = Array.isArray(raw.items) ? raw.items : [];
  if (rawItems.length === 0) return null;

  const derived = rawItems.reduce((sum, it) => {
    if (!it || typeof it !== "object") return sum;
    const qty = toPositiveInt(it.qty ?? it.quantity, 0);
    const unitPrice = normalizeNumber(it.unitPrice ?? it.unit_price ?? it.price) ?? 0;
    if (qty <= 0) return sum;
    return sum + unitPrice * qty;
  }, 0);
  return derived;
}

function getSaleNetSales(raw, derivedSubtotal) {
  if (!raw || typeof raw !== "object") return null;
  const totals = raw.totals && typeof raw.totals === "object" ? raw.totals : {};
  const direct =
    normalizeNumber(totals.amountDue) ??
    normalizeNumber(totals.total) ??
    normalizeNumber(raw.amountDue) ??
    normalizeNumber(raw.total) ??
    normalizeNumber(raw.netSales) ??
    normalizeNumber(raw.net_sales) ??
    null;
  const refunds =
    normalizeNumber(totals.refunds) ??
    normalizeNumber(raw.refunds) ??
    normalizeNumber(raw.refundTotal) ??
    0;
  if (direct != null) return direct - refunds;

  const discount =
    normalizeNumber(totals.discount) ??
    normalizeNumber(totals.discounts) ??
    normalizeNumber(raw.discount) ??
    normalizeNumber(raw.discounts) ??
    null;
  if (derivedSubtotal == null) return null;
  return derivedSubtotal - (discount || 0) - refunds;
}

function getSaleDiscountAmount(raw, derivedSubtotal) {
  if (!raw || typeof raw !== "object") return null;
  const totals = raw.totals && typeof raw.totals === "object" ? raw.totals : {};

  const direct =
    normalizeNumber(totals.discount) ??
    normalizeNumber(totals.discounts) ??
    normalizeNumber(raw.discount) ??
    normalizeNumber(raw.discounts) ??
    null;
  if (direct != null) return Math.max(0, direct);

  const discountLines = Array.isArray(raw.discounts) ? raw.discounts : [];
  if (discountLines.length) {
    const sum = discountLines.reduce((acc, d) => {
      if (!d || typeof d !== "object") return acc;
      const amount = normalizeNumber(d.amount ?? d.discount ?? d.value ?? d.total) ?? 0;
      return acc + amount;
    }, 0);
    if (Number.isFinite(sum) && sum > 0) return sum;
  }

  if (derivedSubtotal == null) return null;
  const net = getSaleNetSales(raw, derivedSubtotal);
  if (net == null) return null;
  return Math.max(0, derivedSubtotal - net);
}

function getSaleCostOfGoods(raw, costByItemId) {
  if (!raw || typeof raw !== "object") return 0;
  const rawItems = Array.isArray(raw.items) ? raw.items : [];
  if (rawItems.length === 0) return 0;
  return rawItems.reduce((sum, it) => {
    if (!it || typeof it !== "object") return sum;
    const itemId = it.itemId ?? it.item_id ?? it.id ?? it._id ?? null;
    const qty = toPositiveInt(it.qty ?? it.quantity, 0);
    if (!itemId || qty <= 0) return sum;
    const directCost =
      normalizeNumber(it.cost ?? it.unitCost ?? it.unit_cost ?? it.costPrice ?? it.cost_price) ??
      null;
    const lookupCost =
      directCost != null
        ? directCost
        : normalizeNumber(costByItemId?.get?.(String(itemId))) ?? 0;
    return sum + lookupCost * qty;
  }, 0);
}

export default function EndOfDayCashPage({
  apiBaseUrl,
  authToken,
  authUser,
  lockedEmployeeId = "",
  hideStoreFilter = false,
}) {
  const todayKey = useMemo(() => formatIsoDateInput(new Date()), []);
  const authRole = useMemo(() => getAuthUserRole(authUser), [authUser]);
  const canPickStore = authRole === "admin" || authRole === "owner";
  const showGrossProfit = authRole !== "cashier";
  const reportStoreId = useMemo(() => getReportStoreId(authUser), [authUser]);
  const lockedCashierId = useMemo(() => String(lockedEmployeeId || "").trim(), [lockedEmployeeId]);

  const [date, setDate] = useState(() => todayKey);
  const [storeId, setStoreId] = useState(() => reportStoreId);

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [grossSales, setGrossSales] = useState(0);
  const [netSales, setNetSales] = useState(0);
  const [discounts, setDiscounts] = useState(0);
  const [grossProfit, setGrossProfit] = useState(0);

  const lastFetchId = useRef(0);

  const getAuthHeaders = useCallback(() => {
    const headers = { "Content-Type": "application/json" };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    return { ...headers, ...getActorHeaders(authUser) };
  }, [authToken, authUser]);

  const apiRequest = useCallback(
    async (path) => {
      const url = `${apiBaseUrl}${path}`;
      const response = await fetch(url, {
        method: "GET",
        headers: getAuthHeaders(),
        credentials: getFetchCredentials(),
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
    if (!canPickStore) {
      setStoreId(reportStoreId);
      return;
    }
    if (authRole !== "admin" && reportStoreId && !storeId) {
      setStoreId(reportStoreId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authRole, canPickStore, reportStoreId]);

  const fetchAllPages = useCallback(
    async (basePath, { maxPages = 12 } = {}) => {
      const results = [];
      let currentPage = 1;
      while (currentPage <= maxPages) {
        const path = basePath.includes("?")
          ? `${basePath}&page=${currentPage}`
          : `${basePath}?page=${currentPage}`;
        const payload = await apiRequest(path);
        const parsed = parsePagedResponse(payload, { page: currentPage, limit: 1000 });
        const pageData = Array.isArray(parsed.data) ? parsed.data : [];
        results.push(...pageData);
        if (!parsed.hasNext || pageData.length === 0) break;
        currentPage += 1;
      }
      return results;
    },
    [apiRequest],
  );

  useEffect(() => {
    if (!apiBaseUrl) return;
    if (!date) return;
    const bounds = getLocalDayBounds(date);
    if (!bounds) return;

    const fetchId = ++lastFetchId.current;
    setIsLoading(true);
    setError("");

    (async () => {
      try {
        const query = buildQueryString({
          startDate: date,
          endDate: date,
          from: date,
          to: date,
          storeId: storeId || undefined,
          employeeId: lockedCashierId || undefined,
          cashierId: lockedCashierId || undefined,
          page: 1,
          limit: 500,
        });

        const itemsQuery = buildQueryString({
          storeId: storeId || undefined,
          page: 1,
          limit: 100,
        });

        const [rawSales, rawItems] = await Promise.all([
          fetchAllPages(`/sales${query}`, { maxPages: 12 }),
          showGrossProfit
            ? fetchAllPages(`/items${itemsQuery}`, { maxPages: 50 }).catch(() => null)
            : Promise.resolve(null),
        ]);

        const costByItemId = new Map();
        if (showGrossProfit && rawItems) {
          const itemsList = extractSalesList(rawItems);
          for (const it of itemsList) {
            if (!it || typeof it !== "object") continue;
            const id = it.id ?? it._id ?? it.itemId ?? it.uuid ?? null;
            if (!id) continue;
            const cost = normalizeNumber(it.cost ?? it.unitCost ?? it.unit_cost);
            if (Number.isFinite(cost)) costByItemId.set(String(id), cost);
          }
        }

        const list = extractSalesList(rawSales);
        const filtered = list.filter((s) => {
          const dt = getSaleCreatedAt(s);
          if (!dt) return false;
          return dt >= bounds.start && dt < bounds.end;
        }).filter((s) => {
          if (!lockedCashierId) return true;
          return getSaleCashierId(s) === lockedCashierId;
        });
        const totals = filtered.reduce(
          (acc, s) => {
            const saleGross = getSaleGrossSales(s);
            const gross = saleGross ?? 0;
            const net = getSaleNetSales(s, saleGross) ?? 0;
            const discount = getSaleDiscountAmount(s, saleGross) ?? 0;
            const cogs = showGrossProfit ? getSaleCostOfGoods(s, costByItemId) : 0;
            acc.grossSales += gross;
            acc.netSales += net;
            acc.discounts += Math.max(0, discount);
            acc.grossProfit += net - cogs;
            return acc;
          },
          { grossSales: 0, netSales: 0, discounts: 0, grossProfit: 0 },
        );

        if (fetchId !== lastFetchId.current) return;
        setGrossSales(Math.round(totals.grossSales * 100) / 100);
        setNetSales(Math.round(totals.netSales * 100) / 100);
        setDiscounts(Math.round(totals.discounts * 100) / 100);
        setGrossProfit(Math.round(totals.grossProfit * 100) / 100);
      } catch (e) {
        if (fetchId !== lastFetchId.current) return;
        setError(e instanceof Error ? e.message : "Failed to load end-of-day cash.");
        setGrossSales(0);
        setNetSales(0);
        setDiscounts(0);
        setGrossProfit(0);
      } finally {
        if (fetchId === lastFetchId.current) setIsLoading(false);
      }
    })();
  }, [apiBaseUrl, apiRequest, date, fetchAllPages, lockedCashierId, showGrossProfit, storeId]);

  return (
    <div className="page salesSummaryPage">
      <div className="salesSummaryHeaderBar" aria-label="End of Day Cash">
        <div className="salesSummaryHeaderTitle">End of Day Cash</div>
      </div>

      <div className="card salesSummaryFiltersCard">
        <div className="salesSummaryFilters">
          <div className="salesSummaryFilterGroup" aria-label="Date">
            <div className="salesSummaryRangeInputs">
              <input
                className="salesSummaryDateInput"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                aria-label="Report date"
                max={todayKey}
                disabled={isLoading}
              />
            </div>
          </div>

          <div className="salesSummaryFilterGroup">
            {hideStoreFilter ? null : (
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
                {!canPickStore && !storeId ? (
                  <option value="">No store assigned</option>
                ) : null}
                {visibleStoreOptions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name || s.id}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
      </div>

      {error ? <div className="authError salesSummaryError">{error}</div> : null}

      <div className="salesSummaryKpiGrid" aria-label="Key metrics">
        <div className="card salesSummaryKpiCard">
          <div className="salesSummaryKpiLabel">Gross sales</div>
          <div className="salesSummaryKpiValue">
            {isLoading ? "--" : formatMoney(grossSales)}
          </div>
          <div className="salesSummaryKpiDelta salesSummaryKpiDeltaUp">
            {isLoading ? "Loading..." : `For ${date || "--"}`}
          </div>
        </div>

        <div className="card salesSummaryKpiCard">
          <div className="salesSummaryKpiLabel">Net sales</div>
          <div className="salesSummaryKpiValue">
            {isLoading ? "--" : formatMoney(netSales)}
          </div>
          <div className="salesSummaryKpiDelta salesSummaryKpiDeltaUp">
            {isLoading ? "Loading..." : `For ${date || "--"}`}
          </div>
        </div>

        <div className="card salesSummaryKpiCard">
          <div className="salesSummaryKpiLabel">Discounts</div>
          <div className="salesSummaryKpiValue">
            {isLoading ? "--" : formatMoney(discounts)}
          </div>
          <div className="salesSummaryKpiDelta salesSummaryKpiDeltaUp">
            {isLoading ? "Loading..." : `For ${date || "--"}`}
          </div>
        </div>

        {showGrossProfit ? (
          <div className="card salesSummaryKpiCard">
            <div className="salesSummaryKpiLabel">Gross profit</div>
            <div className="salesSummaryKpiValue">
              {isLoading ? "--" : formatMoney(grossProfit)}
            </div>
            <div className="salesSummaryKpiDelta salesSummaryKpiDeltaUp">
              {isLoading ? "Loading..." : `For ${date || "--"}`}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
