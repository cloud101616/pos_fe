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

function formatIsoMonthInput(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function getLocalMonthBounds(monthKey) {
  const raw = String(monthKey || "").trim();
  const match = /^(\d{4})-(\d{2})$/.exec(raw);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return null;
  const start = new Date(y, m - 1, 1, 0, 0, 0, 0);
  const endExclusive = new Date(y, m, 1, 0, 0, 0, 0);
  return { start, endExclusive };
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

function sumDiscountAmounts(discounts) {
  if (!Array.isArray(discounts)) return null;
  let sum = 0;
  let hasAny = false;
  for (const d of discounts) {
    if (!d || typeof d !== "object") continue;
    const amount =
      normalizeNumber(d.amount) ??
      normalizeNumber(d.discountAmount) ??
      normalizeNumber(d.discount_amount) ??
      null;
    if (!Number.isFinite(amount)) continue;
    sum += amount;
    hasAny = true;
  }
  return hasAny ? sum : 0;
}

function getLocalDayKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return formatIsoDateInput(date);
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

function getSaleDiscount(raw) {
  if (!raw || typeof raw !== "object") return 0;
  const totals = raw.totals && typeof raw.totals === "object" ? raw.totals : {};
  let discount =
    normalizeNumber(totals.discount) ??
    normalizeNumber(totals.discounts) ??
    normalizeNumber(raw.discount) ??
    null;
  if (discount == null) {
    const fromArray = sumDiscountAmounts(raw.discounts);
    if (fromArray != null) discount = fromArray;
  }
  if (discount == null) discount = 0;
  return discount;
}

function getSaleRefunds(raw) {
  if (!raw || typeof raw !== "object") return 0;
  const totals = raw.totals && typeof raw.totals === "object" ? raw.totals : {};
  return (
    normalizeNumber(totals.refunds) ??
    normalizeNumber(raw.refunds) ??
    normalizeNumber(raw.refundTotal) ??
    0
  );
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
  const refunds = getSaleRefunds(raw);
  if (direct != null) return direct - refunds;
  const discount = getSaleDiscount(raw);
  if (derivedSubtotal == null) return null;
  return derivedSubtotal - (discount || 0) - refunds;
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

function getSaleCashierId(raw) {
  if (!raw || typeof raw !== "object") return "";
  const id =
    raw.cashierId ??
    raw.cashier_id ??
    raw.employeeId ??
    raw.employee_id ??
    raw.userId ??
    raw.user_id ??
    raw.cashier?.id ??
    raw.cashier?._id ??
    null;
  return id == null ? "" : String(id);
}

function getSaleCashierName(raw) {
  if (!raw || typeof raw !== "object") return "";
  const name =
    raw.cashierName ??
    raw.cashier_name ??
    raw.employeeName ??
    raw.employee_name ??
    raw.cashier?.name ??
    raw.cashier?.fullName ??
    raw.user?.name ??
    "";
  return String(name || "");
}

function normalizeSale(raw, costByItemId) {
  if (!raw || typeof raw !== "object") return null;
  const createdAt = raw.createdAt ?? raw.created_at ?? raw.date ?? raw.datetime ?? null;
  const dayKey = getLocalDayKey(createdAt);
  if (!dayKey) return null;

  const grossSales = getSaleGrossSales(raw) ?? 0;
  const discounts = getSaleDiscount(raw) ?? 0;
  const refunds = getSaleRefunds(raw) ?? 0;
  const netSales = getSaleNetSales(raw, grossSales) ?? 0;
  const costOfGoods = getSaleCostOfGoods(raw, costByItemId) ?? 0;
  const grossProfit = netSales - costOfGoods;

  return {
    dayKey,
    cashierId: getSaleCashierId(raw),
    cashierName: getSaleCashierName(raw),
    grossSales,
    refunds,
    discounts,
    netSales,
    costOfGoods,
    grossProfit,
  };
}

function aggregateByDay(sales) {
  const byDay = new Map();
  for (const sale of sales) {
    const key = sale.dayKey;
    const current = byDay.get(key) || {
      dayKey: key,
      grossSales: 0,
      refunds: 0,
      discounts: 0,
      netSales: 0,
      costOfGoods: 0,
      grossProfit: 0,
    };
    current.grossSales += sale.grossSales || 0;
    current.refunds += sale.refunds || 0;
    current.discounts += sale.discounts || 0;
    current.netSales += sale.netSales || 0;
    current.costOfGoods += sale.costOfGoods || 0;
    current.grossProfit += sale.grossProfit || 0;
    byDay.set(key, current);
  }
  return byDay;
}

function sumTotals(list) {
  return list.reduce(
    (acc, row) => {
      acc.grossSales += row.grossSales || 0;
      acc.refunds += row.refunds || 0;
      acc.discounts += row.discounts || 0;
      acc.netSales += row.netSales || 0;
      acc.costOfGoods += row.costOfGoods || 0;
      acc.grossProfit += row.grossProfit || 0;
      return acc;
    },
    {
      grossSales: 0,
      refunds: 0,
      discounts: 0,
      netSales: 0,
      costOfGoods: 0,
      grossProfit: 0,
    },
  );
}

function toCsv(rows) {
  const escape = (v) => {
    const s = v == null ? "" : String(v);
    if (/[",\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
    return s;
  };
  return rows.map((r) => r.map(escape).join(",")).join("\n");
}

function downloadTextFile({ filename, content, mime = "text/plain;charset=utf-8" }) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function MonthlySalesPage({ apiBaseUrl, authToken, authUser }) {
  const todayMonthKey = useMemo(() => formatIsoMonthInput(new Date()), []);
  const authRole = useMemo(() => getAuthUserRole(authUser), [authUser]);
  const canPickStore = authRole === "admin" || authRole === "owner";
  const reportStoreId = useMemo(() => getReportStoreId(authUser), [authUser]);

  const [monthKey, setMonthKey] = useState(() => todayMonthKey);
  const [storeId, setStoreId] = useState(() => reportStoreId);
  const [employeeId, setEmployeeId] = useState("all");
  const [employees, setEmployees] = useState([]);

  const [monthSales, setMonthSales] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

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
    if (!monthKey) return;
    const bounds = getLocalMonthBounds(monthKey);
    if (!bounds) return;

    const fetchId = ++lastFetchId.current;
    setIsLoading(true);
    setError("");

    (async () => {
      try {
        const startKey = formatIsoDateInput(bounds.start);
        const endKey = formatIsoDateInput(new Date(bounds.endExclusive.getTime() - 1));
        const query = buildQueryString({
          startDate: startKey,
          endDate: endKey,
          from: startKey,
          to: endKey,
          storeId: storeId || undefined,
          page: 1,
          limit: 500,
        });

        const itemsQuery = buildQueryString({
          limit: 2000,
          page: 1,
          storeId: storeId || undefined,
        });

        const [rawSales, rawItems] = await Promise.all([
          fetchAllPages(`/sales${query}`, { maxPages: 12 }),
          apiRequest(`/items${itemsQuery}`).catch(() => null),
        ]);

        const itemsList = rawItems ? extractSalesList(rawItems) : [];
        const costByItemId = new Map();
        for (const it of itemsList) {
          if (!it || typeof it !== "object") continue;
          const id = it.id ?? it._id ?? it.itemId ?? it.uuid ?? null;
          if (!id) continue;
          const cost = normalizeNumber(it.cost ?? it.unitCost ?? it.unit_cost);
          if (Number.isFinite(cost)) costByItemId.set(String(id), cost);
        }

        const normalized = extractSalesList(rawSales)
          .map((s) => normalizeSale(s, costByItemId))
          .filter(Boolean)
          .filter((s) => s.dayKey >= startKey && s.dayKey <= endKey);

        const employeeMap = new Map();
        for (const s of normalized) {
          if (!s.cashierId || s.cashierId === "null") continue;
          const label = s.cashierName?.trim() ? s.cashierName.trim() : s.cashierId;
          employeeMap.set(s.cashierId, label);
        }
        const employeeOptions = [...employeeMap.entries()]
          .map(([id, label]) => ({ id, label }))
          .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));

        if (fetchId !== lastFetchId.current) return;
        setMonthSales(normalized);
        setEmployees(employeeOptions);
      } catch (e) {
        if (fetchId !== lastFetchId.current) return;
        setError(e instanceof Error ? e.message : "Failed to load monthly sales.");
        setMonthSales([]);
        setEmployees([]);
      } finally {
        if (fetchId === lastFetchId.current) setIsLoading(false);
      }
    })();
  }, [apiBaseUrl, apiRequest, fetchAllPages, monthKey, storeId]);

  const tableRows = useMemo(() => {
    const filtered = employeeId === "all" ? monthSales : monthSales.filter((s) => s.cashierId === employeeId);
    const byDay = aggregateByDay(filtered);
    return [...byDay.values()].sort((a, b) => a.dayKey.localeCompare(b.dayKey));
  }, [employeeId, monthSales]);

  const totals = useMemo(() => {
    const sum = sumTotals(tableRows);
    return {
      grossSales: Math.round(sum.grossSales * 100) / 100,
      refunds: Math.round(sum.refunds * 100) / 100,
      discounts: Math.round(sum.discounts * 100) / 100,
      netSales: Math.round(sum.netSales * 100) / 100,
      costOfGoods: Math.round(sum.costOfGoods * 100) / 100,
      grossProfit: Math.round(sum.grossProfit * 100) / 100,
    };
  }, [tableRows]);

  const monthLabel = useMemo(() => {
    const bounds = getLocalMonthBounds(monthKey);
    if (!bounds) return monthKey || "--";
    return new Intl.DateTimeFormat("en-PH", { month: "short", year: "numeric" }).format(bounds.start);
  }, [monthKey]);

  const exportCsv = useCallback(() => {
    const header = ["Date", "Gross sales", "Refunds", "Discounts", "Net sales", "Cost of goods", "Gross profit"];
    const rows = tableRows.map((r) => [
      r.dayKey,
      (r.grossSales || 0).toFixed(2),
      (r.refunds || 0).toFixed(2),
      (r.discounts || 0).toFixed(2),
      (r.netSales || 0).toFixed(2),
      (r.costOfGoods || 0).toFixed(2),
      (r.grossProfit || 0).toFixed(2),
    ]);
    const csv = `${toCsv([header, ...rows])}\n`;
    const filename = `monthly-sales_${monthKey || "month"}.csv`;
    downloadTextFile({ filename, content: `\uFEFF${csv}`, mime: "text/csv;charset=utf-8" });
  }, [monthKey, tableRows]);

  return (
    <div className="page salesSummaryPage">
      <div className="salesSummaryHeaderBar" aria-label="Monthly sales">
        <div className="salesSummaryHeaderTitle">Monthly sales</div>
      </div>

      <div className="card salesSummaryFiltersCard">
        <div className="salesSummaryFilters">
          <div className="salesSummaryFilterGroup" aria-label="Month">
            <div className="salesSummaryRangeInputs">
              <input
                className="salesSummaryDateInput"
                type="month"
                value={monthKey}
                onChange={(e) => setMonthKey(e.target.value)}
                aria-label="Report month"
                max={todayMonthKey}
                disabled={isLoading}
              />
            </div>
          </div>

          <div className="salesSummaryFilterGroup">
            <select
              className="select"
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
              aria-label="Employee filter"
              disabled={isLoading}
            >
              <option value="all">All employees</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                </option>
              ))}
            </select>
          </div>

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
        </div>
      </div>

      {error ? <div className="authError salesSummaryError">{error}</div> : null}

      <div className="salesSummaryKpiGrid" aria-label="Monthly key metrics">
        <div className="card salesSummaryKpiCard">
          <div className="salesSummaryKpiLabel">Gross sales</div>
          <div className="salesSummaryKpiValue">{isLoading ? "--" : formatMoney(totals.grossSales)}</div>
          <div className="salesSummaryKpiDelta salesSummaryKpiDeltaUp">
            {isLoading ? "Loading..." : `For ${monthLabel || "--"}`}
          </div>
        </div>

        <div className="card salesSummaryKpiCard">
          <div className="salesSummaryKpiLabel">Refunds</div>
          <div className="salesSummaryKpiValue">{isLoading ? "--" : formatMoney(totals.refunds)}</div>
          <div className="salesSummaryKpiDelta salesSummaryKpiDeltaUp">
            {isLoading ? "Loading..." : `For ${monthLabel || "--"}`}
          </div>
        </div>

        <div className="card salesSummaryKpiCard">
          <div className="salesSummaryKpiLabel">Discounts</div>
          <div className="salesSummaryKpiValue">{isLoading ? "--" : formatMoney(totals.discounts)}</div>
          <div className="salesSummaryKpiDelta salesSummaryKpiDeltaUp">
            {isLoading ? "Loading..." : `For ${monthLabel || "--"}`}
          </div>
        </div>

        <div className="card salesSummaryKpiCard">
          <div className="salesSummaryKpiLabel">Net sales</div>
          <div className="salesSummaryKpiValue">{isLoading ? "--" : formatMoney(totals.netSales)}</div>
          <div className="salesSummaryKpiDelta salesSummaryKpiDeltaUp">
            {isLoading ? "Loading..." : `For ${monthLabel || "--"}`}
          </div>
        </div>

        <div className="card salesSummaryKpiCard">
          <div className="salesSummaryKpiLabel">Cost of goods</div>
          <div className="salesSummaryKpiValue">{isLoading ? "--" : formatMoney(totals.costOfGoods)}</div>
          <div className="salesSummaryKpiDelta salesSummaryKpiDeltaUp">
            {isLoading ? "Loading..." : `For ${monthLabel || "--"}`}
          </div>
        </div>

        <div className="card salesSummaryKpiCard">
          <div className="salesSummaryKpiLabel">Gross profit</div>
          <div className="salesSummaryKpiValue">{isLoading ? "--" : formatMoney(totals.grossProfit)}</div>
          <div className="salesSummaryKpiDelta salesSummaryKpiDeltaUp">
            {isLoading ? "Loading..." : `For ${monthLabel || "--"}`}
          </div>
        </div>
      </div>

      <div className="card salesSummaryTableCard" aria-label="Monthly sales breakdown">
        <div className="salesSummaryTableHeader">
          <div className="salesSummaryExportLabel">MONTHLY SALES</div>
          <div className="salesSummaryTableHeaderRight">
            <button
              className="btn btnGhost btnSmall"
              type="button"
              onClick={exportCsv}
              disabled={isLoading || !tableRows.length}
            >
              Download CSV
            </button>
          </div>
        </div>

        <div className="tableWrap">
          <table className="table salesSummaryTable">
            <thead>
              <tr>
                <th className="salesSummaryColDate">Date</th>
                <th className="colMoney">Gross sales</th>
                <th className="colMoney">Refunds</th>
                <th className="colMoney">Discounts</th>
                <th className="colMoney">Net sales</th>
                <th className="colMoney">Cost of goods</th>
                <th className="colMoney">Gross profit</th>
              </tr>
            </thead>
            <tbody>
              {tableRows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="usersEmpty">
                    {isLoading ? "Loading..." : "No results."}
                  </td>
                </tr>
              ) : (
                tableRows.map((r) => (
                  <tr key={r.dayKey}>
                    <td className="salesSummaryColDate">{r.dayKey}</td>
                    <td className="colMoney">{formatMoney(r.grossSales)}</td>
                    <td className="colMoney">{formatMoney(r.refunds)}</td>
                    <td className="colMoney">{formatMoney(r.discounts)}</td>
                    <td className="colMoney">{formatMoney(r.netSales)}</td>
                    <td className="colMoney">{formatMoney(r.costOfGoods)}</td>
                    <td className="colMoney">{formatMoney(r.grossProfit)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
