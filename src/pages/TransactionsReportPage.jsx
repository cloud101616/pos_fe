import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  buildQueryString,
  downloadTextFile,
  getActorHeaders,
  getAuthUserRole,
  getFetchCredentials,
  getReportStoreId,
  parsePagedResponse,
  toCsv,
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

function addDays(date, deltaDays) {
  const next = new Date(date);
  next.setDate(next.getDate() + deltaDays);
  return next;
}

function clampDateRange({ start, end }) {
  if (!(start instanceof Date) || Number.isNaN(start.getTime()))
    return { start: null, end: null };
  if (!(end instanceof Date) || Number.isNaN(end.getTime()))
    return { start, end: start };
  if (start <= end) return { start, end };
  return { start: end, end: start };
}

function formatTransactionDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat("en-PH", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function extractList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.data?.results)) return payload.data.results;
  return [];
}

function readText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (typeof value === "object") {
    const preferred =
      value.name ??
      value.fullName ??
      value.email ??
      value.label ??
      value.title ??
      value.id ??
      value._id ??
      "";
    return String(preferred || "").trim();
  }
  return String(value).trim();
}

function normalizeTransactionCategory(raw) {
  if (!raw || typeof raw !== "object") return "sale";
  const value =
    raw.transactionType ??
    raw.transaction_type ??
    raw.type ??
    raw.saleType ??
    raw.sale_type ??
    raw.kind ??
    raw.recordType ??
    raw.record_type ??
    raw.status ??
    "";
  const lowered = String(value || "").trim().toLowerCase();
  if (lowered.includes("refund")) return "refund";
  if (lowered.includes("sale")) return "sale";
  return "sale";
}

function normalizeTotal(raw) {
  if (!raw || typeof raw !== "object") return 0;
  const totals = raw.totals && typeof raw.totals === "object" ? raw.totals : {};
  const value =
    raw.total ??
    raw.amount ??
    raw.amountDue ??
    raw.netSales ??
    raw.net_sales ??
    raw.grandTotal ??
    raw.grand_total ??
    totals.total ??
    totals.amountDue ??
    totals.netSales ??
    null;
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function extractRecordItems(raw) {
  if (!raw || typeof raw !== "object") return [];
  const candidates = [
    raw.items,
    raw.lineItems,
    raw.line_items,
    raw.products,
    raw.productItems,
    raw.product_items,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function toItemName(raw) {
  if (!raw || typeof raw !== "object") return "";
  const direct =
    raw.name ??
    raw.itemName ??
    raw.item_name ??
    raw.title ??
    raw.label ??
    raw.productName ??
    raw.product_name ??
    raw.item?.name ??
    raw.product?.name ??
    "";
  const text = String(direct || "").trim();
  if (text) return text;
  const id =
    raw.itemId ??
    raw.item_id ??
    raw.productId ??
    raw.product_id ??
    raw.id ??
    raw._id ??
    null;
  return id == null ? "" : String(id);
}

function toItemQty(raw) {
  if (!raw || typeof raw !== "object") return 0;
  return toPositiveInt(
    raw.qty ?? raw.quantity ?? raw.count ?? raw.q ?? raw.amount ?? raw.units ?? 0,
    0,
  );
}

function normalizeItems(raw) {
  return extractRecordItems(raw)
    .map((item, index) => {
      const name = toItemName(item);
      const qty = toItemQty(item);
      if (!name && qty <= 0) return null;
      return {
        id: String(item?.id ?? item?._id ?? item?.itemId ?? item?.productId ?? index),
        name: name || `Item ${index + 1}`,
        qty: qty > 0 ? qty : null,
      };
    })
    .filter(Boolean);
}

function formatItemsSummary(items) {
  if (!Array.isArray(items) || items.length === 0) return "--";
  const labels = items
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const name = String(item.name || "").trim();
      const qty = Number.isFinite(item.qty) && item.qty > 0 ? ` x${item.qty}` : "";
      return `${name || "Item"}${qty}`;
    })
    .filter(Boolean);
  if (labels.length === 0) return "--";
  if (labels.length <= 2) return labels.join(", ");
  return `${labels.slice(0, 2).join(", ")} +${labels.length - 2} more`;
}

function normalizeTransaction(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = raw.id ?? raw._id ?? raw.receiptId ?? raw.saleId ?? raw.uuid ?? null;
  if (!id) return null;

  const category = normalizeTransactionCategory(raw);
  const receiptNo =
    raw.receiptNumber ??
    raw.receipt_number ??
    raw.receiptNo ??
    raw.receipt_no ??
    raw.refundReceiptNumber ??
    raw.refund_receipt_number ??
    raw.number ??
    raw.no ??
    raw.saleNumber ??
    raw.sale_number ??
    "";

  const date =
    raw.refundedAt ??
    raw.refunded_at ??
    raw.createdAt ??
    raw.created_at ??
    raw.date ??
    raw.datetime ??
    null;

  const employee =
    readText(raw.employee) ||
    readText(raw.cashier) ||
    readText(raw.employeeName) ||
    readText(raw.employee_name) ||
    readText(raw.cashierName) ||
    readText(raw.cashier_name);

  const customer =
    readText(raw.customer?.name) ||
    readText(raw.customerName) ||
    readText(raw.customer_name) ||
    readText(raw.customer?.email) ||
    readText(raw.customer);
  const items = normalizeItems(raw);

  return {
    id: String(id),
    receiptNo: String(receiptNo || "").trim(),
    date,
    employee: String(employee || "").trim(),
    customer: String(customer || "").trim(),
    items,
    itemsSummary: formatItemsSummary(items),
    category,
    type: category === "refund" ? "Refund" : "Sale",
    total: normalizeTotal(raw),
    raw,
  };
}

function applyTypeFilter(rows, typeFilter) {
  if (typeFilter === "sale") return rows.filter((row) => row.category === "sale");
  if (typeFilter === "refund") return rows.filter((row) => row.category === "refund");
  return rows;
}

function matchesSearch(row, query) {
  const normalized = String(query || "").trim().toLowerCase();
  if (!normalized) return true;
  const fields = [
    row.receiptNo,
    row.id,
    row.itemsSummary,
    row.employee,
    row.customer,
    row.type,
    Number.isFinite(row.total) ? row.total.toFixed(2) : "",
  ];
  return fields.some((value) => String(value || "").toLowerCase().includes(normalized));
}

function parseEmployeesFromPayload(payload) {
  const source = parsePagedResponse(payload, { page: 1, limit: 1000 }).data;
  return extractList(source)
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const id =
        row.employeeId ?? row.employee_id ?? row.id ?? row.userId ?? row.cashierId ?? null;
      if (!id) return null;
      const label =
        String(row.name ?? row.employeeName ?? row.employee_name ?? row.label ?? "").trim() ||
        String(id);
      return { id: String(id), label };
    })
    .filter(Boolean)
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
}

function buildDemoTransactions() {
  const now = new Date().toISOString();
  return [
    normalizeTransaction({
      id: "demo-sale-1",
      receiptNo: "T-1001",
      createdAt: now,
      employee: "Owner",
      customer: "Walk-in",
      items: [
        { itemId: "demo-item-1", name: "X-ULTRA (GRAPES)", qty: 1 },
        { itemId: "demo-item-2", name: "Y-ULTRA", qty: 2 },
      ],
      type: "sale",
      total: 450,
    }),
    normalizeTransaction({
      id: "demo-refund-1",
      receiptNo: "R-1001",
      refundedAt: now,
      employee: "Owner",
      customer: "Walk-in",
      items: [{ itemId: "demo-item-1", name: "X-ULTRA (GRAPES)", qty: 1 }],
      type: "refund",
      total: 120,
    }),
  ].filter(Boolean);
}

export default function TransactionsReportPage({ apiBaseUrl, authToken, authUser }) {
  const authRole = useMemo(() => getAuthUserRole(authUser), [authUser]);
  const canPickStore = authRole === "admin" || authRole === "owner";
  const reportStoreId = useMemo(() => getReportStoreId(authUser), [authUser]);
  const [storeId, setStoreId] = useState(() => reportStoreId);
  const todayKey = useMemo(() => formatIsoDateInput(new Date()), []);
  const [startDate, setStartDate] = useState(() => formatIsoDateInput(new Date()));
  const [endDate, setEndDate] = useState(() => formatIsoDateInput(new Date()));
  const [typeFilter, setTypeFilter] = useState("all");
  const [employeeId, setEmployeeId] = useState("all");
  const [q, setQ] = useState("");

  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [isDemoData, setIsDemoData] = useState(false);

  const [employees, setEmployees] = useState([]);
  const [sourceRows, setSourceRows] = useState([]);
  const [summary, setSummary] = useState({ allTransactions: 0, sales: 0, refunds: 0 });
  const [selected, setSelected] = useState(null);

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
    return storeOptions.filter((store) => String(store.id) === active);
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
    setPage(1);
  }, [employeeId, endDate, limit, q, startDate, storeId, typeFilter]);

  const allRows = useMemo(() => {
    return applyTypeFilter(sourceRows, typeFilter).filter((row) => matchesSearch(row, q));
  }, [q, sourceRows, typeFilter]);

  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(allRows.length / limit));
    if (page > totalPages) setPage(totalPages);
  }, [allRows.length, limit, page]);

  useEffect(() => {
    if (!selected) return;
    if (allRows.some((row) => row.id === selected.id)) return;
    setSelected(null);
  }, [allRows, selected]);

  useEffect(() => {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const clamped = clampDateRange({ start, end });
    if (!clamped.start || !clamped.end) return;

    const fetchId = ++lastFetchId.current;
    setIsLoading(true);
    setError("");
    setIsDemoData(false);

    (async () => {
      try {
        const from = formatIsoDateInput(clamped.start);
        const to = formatIsoDateInput(clamped.end);
        const baseParams = {
          from,
          to,
          storeId: storeId || undefined,
          ...(employeeId !== "all" ? { employeeId } : null),
        };

        const employeesPromise = apiRequest(
          `/sales/reports/by-employee${buildQueryString({
            from,
            to,
            storeId: storeId || undefined,
            page: 1,
            limit: 1000,
          })}`,
        ).catch(() => null);

        const pageSize = 200;
        const maxPages = 50;
        const collected = [];
        let requestPage = 1;
        let hasMore = true;

        while (hasMore && requestPage <= maxPages) {
          const payload = await apiRequest(
            `/sales/reports/receipts${buildQueryString({
              ...baseParams,
              page: requestPage,
              limit: pageSize,
            })}`,
          );

          const parsed = parsePagedResponse(payload, { page: requestPage, limit: pageSize });
          const batch = extractList(parsed.data).map(normalizeTransaction).filter(Boolean);
          collected.push(...batch);

          const hasMoreByFlag = Boolean(parsed.hasNext);
          const hasMoreByTotal =
            typeof parsed.total === "number" && parsed.total > requestPage * pageSize;
          const hasMoreByFullPage = batch.length === pageSize;

          hasMore = hasMoreByFlag || hasMoreByTotal || hasMoreByFullPage;
          if (!hasMore) break;
          requestPage += 1;
        }

        const employeePayload = await employeesPromise;
        if (fetchId !== lastFetchId.current) return;

        setEmployees(employeePayload ? parseEmployeesFromPayload(employeePayload) : []);
        setSummary({
          allTransactions: collected.length,
          sales: collected.filter((row) => row.category === "sale").length,
          refunds: collected.filter((row) => row.category === "refund").length,
        });
        setSourceRows(collected);

        if (requestPage > maxPages && hasMore) {
          setError("Showing the first 10,000 transactions for this range.");
        }
      } catch (e) {
        if (fetchId !== lastFetchId.current) return;
        const message = e instanceof Error ? e.message : "Failed to load transactions.";
        setError(`${message} (Showing demo data)`);
        setIsDemoData(true);
        setEmployees([{ id: "demo", label: "Owner" }]);
        setSummary({ allTransactions: 2, sales: 1, refunds: 1 });
        setSourceRows(buildDemoTransactions());
      } finally {
        if (fetchId === lastFetchId.current) setIsLoading(false);
      }
    })();
  }, [apiRequest, employeeId, endDate, startDate, storeId]);

  const total = allRows.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const hasPrev = page > 1;
  const hasNext = page < totalPages;

  const rows = useMemo(() => {
    const offset = (page - 1) * limit;
    return allRows.slice(offset, offset + limit);
  }, [allRows, limit, page]);

  const exportCsv = useCallback(() => {
    const csvRows = allRows.map((row) => [
      row.receiptNo || row.id,
      row.date ? new Date(row.date).toISOString() : "",
      String(row.itemsSummary || "").replaceAll("\n", "; "),
      row.employee,
      row.customer,
      row.type,
      (Number(row.total) || 0).toFixed(2),
    ]);
    const csv = `${toCsv([
      ["Receipt no.", "Date", "Items", "Employee", "Customer", "Type", "Total"],
      ...csvRows,
    ])}\n`;
    const filename = `transactions_${startDate || "start"}_${endDate || "end"}_${typeFilter}.csv`;
    downloadTextFile({ filename, content: `\uFEFF${csv}`, mime: "text/csv;charset=utf-8" });
  }, [allRows, endDate, startDate, typeFilter]);

  const rangeLabel = useMemo(() => {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const clamped = clampDateRange({ start, end });
    if (!clamped.start || !clamped.end) return "--";
    return `${formatIsoDateInput(clamped.start)} - ${formatIsoDateInput(clamped.end)}`;
  }, [endDate, startDate]);

  const emptyLabel = useMemo(() => {
    if (isLoading) return "Loading...";
    if (typeFilter === "sale") return "No sales found.";
    if (typeFilter === "refund") return "No refunds found.";
    return "No transactions found.";
  }, [isLoading, typeFilter]);

  return (
    <div className="page receiptsReportPage">
      <div className="salesSummaryHeaderBar" aria-label="Transactions">
        <div className="salesSummaryHeaderTitle">Transactions</div>
      </div>

      <div className="card salesSummaryFiltersCard">
        <div className="salesSummaryFilters">
          <div className="salesSummaryFilterGroup" aria-label="Date range">
            <button
              className="salesSummaryRangeBtn"
              type="button"
              aria-label="Previous period"
              onClick={() => {
                const start = new Date(startDate);
                const end = new Date(endDate);
                const clamped = clampDateRange({ start, end });
                if (!clamped.start || !clamped.end) return;
                const days = Math.max(1, Math.round((clamped.end - clamped.start) / 86400000) + 1);
                setStartDate(formatIsoDateInput(addDays(clamped.start, -days)));
                setEndDate(formatIsoDateInput(addDays(clamped.end, -days)));
              }}
              disabled={isLoading}
            >
              {"<"}
            </button>
            <div className="salesSummaryRangeInputs">
              <input
                className="salesSummaryDateInput"
                type="date"
                value={startDate}
                onChange={(e) => {
                  const next = e.target.value;
                  if (next && todayKey && next > todayKey) {
                    setStartDate(todayKey);
                    return;
                  }
                  setStartDate(next);
                }}
                aria-label="Start date"
                max={todayKey}
                disabled={isLoading}
              />
              <span className="salesSummaryRangeDash" aria-hidden="true">
                --
              </span>
              <input
                className="salesSummaryDateInput"
                type="date"
                value={endDate}
                onChange={(e) => {
                  const next = e.target.value;
                  if (next && todayKey && next > todayKey) {
                    setEndDate(todayKey);
                    return;
                  }
                  setEndDate(next);
                }}
                aria-label="End date"
                max={todayKey}
                disabled={isLoading}
              />
            </div>
            <button
              className="salesSummaryRangeBtn"
              type="button"
              aria-label="Next period"
              onClick={() => {
                const start = new Date(startDate);
                const end = new Date(endDate);
                const clamped = clampDateRange({ start, end });
                if (!clamped.start || !clamped.end) return;
                const days = Math.max(1, Math.round((clamped.end - clamped.start) / 86400000) + 1);
                const candidateEnd = addDays(clamped.end, days);
                const candidateEndKey = formatIsoDateInput(candidateEnd);
                if (todayKey && candidateEndKey > todayKey) {
                  const todayDate = dateFromIsoDateInput(todayKey);
                  if (!todayDate) return;
                  setEndDate(todayKey);
                  setStartDate(formatIsoDateInput(addDays(todayDate, -(days - 1))));
                  return;
                }
                setStartDate(formatIsoDateInput(addDays(clamped.start, days)));
                setEndDate(candidateEndKey);
              }}
              disabled={isLoading || (todayKey && endDate && endDate >= todayKey)}
            >
              {">"}
            </button>
          </div>

          <div className="salesSummaryFilterGroup">
            <select
              className="select"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              aria-label="Transaction type filter"
              disabled={isLoading}
            >
              <option value="all">All transactions</option>
              <option value="sale">Sales only</option>
              <option value="refund">Refunds only</option>
            </select>
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
              {employees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.label}
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
              {visibleStoreOptions.map((store) => (
                <option key={store.id} value={store.id}>
                  {store.name || store.id}
                </option>
              ))}
            </select>
          </div>

          <div className="salesSummaryFiltersRight">
            <div className="salesByItemRangeMeta" title={rangeLabel}>
              {rangeLabel}
            </div>
          </div>
        </div>
      </div>

      {error ? <div className="authError salesSummaryError">{error}</div> : null}
      {isDemoData ? (
        <div className="salesSummaryHint">Demo data is generated locally to preview the layout.</div>
      ) : null}

      <div className="receiptsReportContent">
        <div className="receiptsReportMain">
          <div className="card receiptsReportStats">
            <div className="receiptsStat">
              <div className="receiptsStatLabel">All transactions</div>
              <div className="receiptsStatValue">{summary.allTransactions || 0}</div>
            </div>
            <div className="receiptsStatDivider" aria-hidden="true" />
            <div className="receiptsStat">
              <div className="receiptsStatLabel">Sales</div>
              <div className="receiptsStatValue">{summary.sales || 0}</div>
            </div>
            <div className="receiptsStatDivider" aria-hidden="true" />
            <div className="receiptsStat">
              <div className="receiptsStatLabel">Refunds</div>
              <div className="receiptsStatValue">{summary.refunds || 0}</div>
            </div>
          </div>

          <div className="card salesSummaryTableCard">
            <div className="salesSummaryTableHeader">
              <div className="salesSummaryExportLabel">EXPORT</div>
              <div className="receiptsReportHeaderRight">
                <input
                  className="receiptsSearchInput"
                  type="search"
                  placeholder="Search receipt, employee, or customer"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  disabled={isLoading}
                  aria-label="Search transactions"
                />
                <button
                  className="btn btnGhost btnSmall"
                  type="button"
                  onClick={exportCsv}
                  disabled={isLoading || allRows.length === 0}
                >
                  Download CSV
                </button>
              </div>
            </div>

            <div className="tableWrap">
              <table className="table receiptsTable">
                <thead>
                  <tr>
                    <th className="receiptsColNo">Receipt no.</th>
                    <th className="receiptsColDate">Date</th>
                    <th className="receiptsColItems">Items</th>
                    <th className="receiptsColEmployee">Employee</th>
                    <th className="receiptsColCustomer">Customer</th>
                    <th className="receiptsColType">Type</th>
                    <th className="colMoney">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="usersEmpty">
                        {emptyLabel}
                      </td>
                    </tr>
                  ) : (
                    rows.map((row) => (
                      <tr
                        key={row.id}
                        className={`receiptsRow ${selected?.id === row.id ? "receiptsRowActive" : ""}`}
                        onClick={() => setSelected(row)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") setSelected(row);
                        }}
                      >
                        <td className="receiptsColNo">{row.receiptNo || row.id}</td>
                        <td className="receiptsColDate">{formatTransactionDate(row.date)}</td>
                        <td
                          className="receiptsColItems"
                          title={
                            row.items?.length
                              ? row.items
                                  .map((item) => `${item.name}${item.qty ? ` x${item.qty}` : ""}`)
                                  .join(", ")
                              : ""
                          }
                        >
                          {row.itemsSummary}
                        </td>
                        <td className="receiptsColEmployee">{row.employee || "--"}</td>
                        <td className="receiptsColCustomer">{row.customer || "--"}</td>
                        <td className="receiptsColType">{row.type}</td>
                        <td className="colMoney">{formatMoney(row.total)}</td>
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
                  disabled={!hasPrev || isLoading}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                >
                  {"<"}
                </button>
                <button
                  className="pagerBtn"
                  type="button"
                  aria-label="Next page"
                  disabled={!hasNext || isLoading}
                  onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                >
                  {">"}
                </button>
              </div>

              <div className="pagerMeta">
                <span>Page:</span>
                <span className="salesSummaryPagerStrong">{page}</span>
                <span>of {totalPages}</span>
              </div>

              <div className="pagerMeta">
                <span>Rows per page:</span>
                <select
                  className="select selectSmall"
                  value={String(limit)}
                  onChange={(e) => setLimit(toPositiveInt(e.target.value, limit))}
                  disabled={isLoading}
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

        <aside className={`receiptsReportDrawer ${selected ? "receiptsReportDrawerOpen" : ""}`}>
          {selected ? (
            <div className="receiptsDrawerBody" role="dialog" aria-label="Transaction details">
              <div className="receiptsDrawerTop">
                <button
                  className="receiptsDrawerClose"
                  type="button"
                  aria-label="Close details"
                  onClick={() => setSelected(null)}
                >
                  &times;
                </button>
              </div>
              <div className="receiptsDrawerTotal">{formatMoney(selected.total)}</div>
              <div className="receiptsDrawerTotalLabel">Total</div>
              <div className="receiptsDrawerDivider" aria-hidden="true" />
              <div className="receiptsDrawerMeta">
                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">Items</span>
                  <span className="receiptsDrawerMetaValue">{selected.itemsSummary}</span>
                </div>
                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">Employee</span>
                  <span className="receiptsDrawerMetaValue">{selected.employee || "--"}</span>
                </div>
                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">Customer</span>
                  <span className="receiptsDrawerMetaValue">{selected.customer || "--"}</span>
                </div>
                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">Type</span>
                  <span className="receiptsDrawerMetaValue">{selected.type}</span>
                </div>
                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">Date</span>
                  <span className="receiptsDrawerMetaValue">
                    {formatTransactionDate(selected.date)}
                  </span>
                </div>
                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">Receipt no.</span>
                  <span className="receiptsDrawerMetaValue">
                    {selected.receiptNo || selected.id}
                  </span>
                </div>
              </div>
              {selected.items?.length ? (
                <>
                  <div className="receiptsDrawerDivider" aria-hidden="true" />
                  <div className="cashierRefundsItemsBlock">
                    <div className="receiptsDrawerMetaLabel">Items</div>
                    <div
                      className="cashierRefundsItemsList"
                      role="list"
                      aria-label="Transaction items"
                    >
                      {selected.items.map((item) => (
                        <div key={item.id} className="cashierRefundsItemRow" role="listitem">
                          <span className="cashierRefundsItemName">{item.name}</span>
                          <span className="cashierRefundsItemQty">
                            {item.qty ? `x${item.qty}` : "--"}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              ) : null}
            </div>
          ) : (
            <div className="receiptsDrawerEmpty">Select a transaction to view details.</div>
          )}
        </aside>
      </div>
    </div>
  );
}
