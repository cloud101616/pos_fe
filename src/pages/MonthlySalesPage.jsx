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

const EMPTY_TOTALS = Object.freeze({
  grossSales: 0,
  refunds: 0,
  discounts: 0,
  netSales: 0,
  costOfGoods: 0,
  grossProfit: 0,
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

function extractSalesList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.data?.results)) return payload.data.results;
  return [];
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

function roundMoney(value) {
  return Math.round((normalizeNumber(value) ?? 0) * 100) / 100;
}

function readMetric(source, keys) {
  for (const key of keys) {
    const value = normalizeNumber(source?.[key]);
    if (value != null) return value;
  }
  return null;
}

function normalizeMonthlyTotals(source) {
  const root = source && typeof source === "object" ? source : {};
  const grossSales =
    readMetric(root, ["grossSales", "gross_sales", "gross", "subtotal"]) ?? 0;
  const refunds =
    readMetric(root, ["refunds", "refundAmount", "refund_amount", "refundTotal", "refund_total"]) ??
    0;
  const discounts =
    readMetric(root, ["discounts", "discount", "discountAmount", "discount_amount"]) ?? 0;
  const netSales =
    readMetric(root, ["netSales", "net_sales", "net", "total", "amountDue", "amount_due"]) ?? 0;
  const costOfGoods =
    readMetric(root, ["costOfGoods", "cost_of_goods", "cogs", "cost"]) ?? 0;
  const grossProfit =
    readMetric(root, ["grossProfit", "gross_profit", "profit"]) ?? (netSales - costOfGoods);

  return {
    grossSales: roundMoney(grossSales),
    refunds: roundMoney(refunds),
    discounts: roundMoney(discounts),
    netSales: roundMoney(netSales),
    costOfGoods: roundMoney(costOfGoods),
    grossProfit: roundMoney(grossProfit),
  };
}

function normalizeDayKey(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return "";
  return formatIsoDateInput(date);
}

function normalizeMonthlyRow(raw) {
  if (!raw || typeof raw !== "object") return null;
  const dayKey = normalizeDayKey(raw.dayKey ?? raw.day_key ?? raw.date ?? raw.day ?? raw.bucket ?? raw.key);
  if (!dayKey) return null;
  const merged = {
    ...(raw && typeof raw === "object" ? raw : {}),
    ...(raw.totals && typeof raw.totals === "object" ? raw.totals : {}),
  };
  return { dayKey, ...normalizeMonthlyTotals(merged) };
}

function normalizeMonthlyReport(payload, fallback = {}) {
  const source =
    payload?.data && typeof payload.data === "object" && !Array.isArray(payload.data)
      ? payload.data
      : payload;
  const root = source && typeof source === "object" ? source : {};
  const rows = extractSalesList(root.data ?? root.rows ?? root.series ?? root.results)
    .map(normalizeMonthlyRow)
    .filter(Boolean)
    .sort((a, b) => a.dayKey.localeCompare(b.dayKey));

  const summarySource =
    root.summary && typeof root.summary === "object" ? root.summary : sumTotals(rows);

  return {
    month: String(root.month ?? fallback.month ?? ""),
    from: String(root.from ?? fallback.from ?? ""),
    to: String(root.to ?? fallback.to ?? ""),
    currency: String(root.currency ?? fallback.currency ?? "PHP"),
    summary: normalizeMonthlyTotals(summarySource),
    rows,
  };
}

function extractEmployeeOptions(payload) {
  const parsed = payload ? parsePagedResponse(payload, { page: 1, limit: 1000 }) : { data: [] };
  return extractSalesList(parsed.data)
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const id =
        row.employeeId ??
        row.employee_id ??
        row.cashierId ??
        row.cashier_id ??
        row.userId ??
        row.user_id ??
        row.id ??
        null;
      if (!id) return null;
      const label =
        String(
          row.name ??
            row.employeeName ??
            row.employee_name ??
            row.cashierName ??
            row.cashier_name ??
            row.label ??
            "",
        ).trim() || String(id);
      return { id: String(id), label };
    })
    .filter(Boolean)
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
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

  const [report, setReport] = useState(() => ({
    month: todayMonthKey,
    from: "",
    to: "",
    currency: "PHP",
    summary: EMPTY_TOTALS,
    rows: [],
  }));
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
        const reportQuery = buildQueryString({
          month: monthKey,
          storeId: storeId || undefined,
          allStores: canPickStore && !storeId ? true : undefined,
          ...(employeeId !== "all"
            ? {
                employeeId,
                cashierId: employeeId,
              }
            : null),
        });
        const employeesQuery = buildQueryString({
          startDate: startKey,
          endDate: endKey,
          from: startKey,
          to: endKey,
          storeId: storeId || undefined,
          allStores: canPickStore && !storeId ? true : undefined,
          page: 1,
          limit: 1000,
        });

        const [reportPayload, employeePayload] = await Promise.all([
          apiRequest(`/sales/reports/monthly-sales${reportQuery}`),
          apiRequest(`/sales/reports/by-employee${employeesQuery}`).catch(() => null),
        ]);

        const nextReport = normalizeMonthlyReport(reportPayload, {
          month: monthKey,
          from: startKey,
          to: endKey,
        });
        const employeeOptions = extractEmployeeOptions(employeePayload);

        if (fetchId !== lastFetchId.current) return;
        setReport(nextReport);
        setEmployees(employeeOptions);
      } catch (e) {
        if (fetchId !== lastFetchId.current) return;
        setError(e instanceof Error ? e.message : "Failed to load monthly sales.");
        setReport({
          month: monthKey,
          from: "",
          to: "",
          currency: "PHP",
          summary: EMPTY_TOTALS,
          rows: [],
        });
        setEmployees([]);
      } finally {
        if (fetchId === lastFetchId.current) setIsLoading(false);
      }
    })();
  }, [apiBaseUrl, apiRequest, canPickStore, employeeId, monthKey, storeId]);

  useEffect(() => {
    if (employeeId === "all") return;
    if (employees.length === 0) return;
    if (employees.some((employee) => employee.id === employeeId)) return;
    setEmployeeId("all");
  }, [employeeId, employees]);

  const tableRows = useMemo(() => {
    return Array.isArray(report.rows) ? report.rows : [];
  }, [report.rows]);

  const totals = useMemo(() => {
    const summary = report.summary && typeof report.summary === "object" ? report.summary : null;
    return normalizeMonthlyTotals(summary ?? sumTotals(tableRows));
  }, [report.summary, tableRows]);

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
