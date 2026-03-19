import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  buildQueryString,
  getActorHeaders,
  getAuthUserRole,
  getFetchCredentials,
  parsePagedResponse,
  resolveStoreId,
  toPositiveInt,
} from "../utils/common.js";

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

function formatReceiptDate(value) {
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

function normalizeType(raw, fallbackType = "sale") {
  if (!raw || typeof raw !== "object") return fallbackType;
  const value =
    raw.transactionType ??
    raw.transaction_type ??
    raw.type ??
    raw.saleType ??
    raw.sale_type ??
    raw.kind ??
    raw.recordType ??
    raw.record_type ??
    "";
  const lowered = String(value || "").trim().toLowerCase();
  if (lowered.includes("refund")) return "refund";
  if (lowered.includes("sale")) return "sale";
  return fallbackType;
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

function isRefundedSale(raw) {
  if (!raw || typeof raw !== "object") return false;

  const booleanFields = [
    raw.refunded,
    raw.isRefunded,
    raw.alreadyRefunded,
    raw.hasRefund,
    raw.has_refund,
  ];
  if (booleanFields.some((value) => value === true)) return true;

  const linkedRefund =
    raw.refundId ??
    raw.refund_id ??
    raw.refundSaleId ??
    raw.refund_sale_id ??
    raw.refundTransactionId ??
    raw.refund_transaction_id ??
    raw.refundedAt ??
    raw.refunded_at ??
    raw.refund?.id ??
    raw.refund?._id ??
    null;
  if (linkedRefund != null && String(linkedRefund).trim()) return true;

  const status = String(
    raw.status ?? raw.saleStatus ?? raw.sale_status ?? raw.state ?? "",
  ).toLowerCase();
  return status.includes("refund");
}

function normalizeRecord(raw, fallbackType = "sale") {
  if (!raw || typeof raw !== "object") return null;

  const id = raw.id ?? raw._id ?? raw.receiptId ?? raw.saleId ?? raw.uuid ?? null;
  if (!id) return null;

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

  const originalSaleId =
    raw.originalSaleId ??
    raw.original_sale_id ??
    raw.saleId ??
    raw.sale_id ??
    raw.originalSale?.id ??
    raw.originalSale?._id ??
    null;

  const reason =
    raw.reason ??
    raw.refundReason ??
    raw.refund_reason ??
    raw.notes ??
    raw.note ??
    "";

  const type = normalizeType(raw, fallbackType);
  const items = normalizeItems(raw);

  return {
    id: String(id),
    receiptNo: String(receiptNo || "").trim(),
    date,
    employee: String(employee || "").trim(),
    customer: String(customer || "").trim(),
    type,
    total: normalizeTotal(raw),
    refunded: type === "sale" ? isRefundedSale(raw) : false,
    items,
    originalSaleId:
      originalSaleId == null || String(originalSaleId).trim() === ""
        ? ""
        : String(originalSaleId),
    reason: String(reason || "").trim(),
    raw,
  };
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

async function readJsonSafely(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export default function CashierRefundsPage({
  apiBaseUrl,
  authToken,
  authUser,
  lockedEmployeeId = "",
  lockedStoreId = "",
  defaultTab = "sales",
  showSalesTab = true,
  allowRefund = true,
}) {
  const authRole = useMemo(() => getAuthUserRole(authUser), [authUser]);
  const cashierId = useMemo(() => {
    if (lockedEmployeeId != null && String(lockedEmployeeId).trim()) {
      return String(lockedEmployeeId).trim();
    }
    if (authRole !== "cashier" || !authUser || typeof authUser !== "object") return "";
    const raw = authUser.id ?? authUser._id ?? authUser.userId ?? authUser.uuid ?? "";
    return typeof raw === "string" || typeof raw === "number" ? String(raw) : "";
  }, [authRole, authUser, lockedEmployeeId]);

  const storeId = useMemo(() => {
    if (lockedStoreId != null && String(lockedStoreId).trim()) {
      return String(lockedStoreId).trim();
    }
    return authRole === "cashier" ? resolveStoreId(authUser) : "";
  }, [authRole, authUser, lockedStoreId]);
  const storeLabel = useMemo(() => {
    if (!storeId) return "All stores";
    const raw =
      authUser?.storeName ??
      authUser?.store_name ??
      authUser?.store?.name ??
      authUser?.store?.storeName ??
      authUser?.store?.label ??
      storeId;
    return String(raw || "").trim() || "Unassigned";
  }, [authUser, storeId]);

  const normalizedDefaultTab = showSalesTab
    ? defaultTab === "refunds"
      ? "refunds"
      : "sales"
    : "refunds";
  const [activeTab, setActiveTab] = useState(normalizedDefaultTab);
  const todayKey = useMemo(() => formatIsoDateInput(new Date()), []);
  const [startDate, setStartDate] = useState(() => {
    const end = new Date();
    return formatIsoDateInput(addDays(end, -29));
  });
  const [endDate, setEndDate] = useState(() => formatIsoDateInput(new Date()));
  const [q, setQ] = useState("");

  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [total, setTotal] = useState(null);
  const [hasNext, setHasNext] = useState(false);
  const [hasPrev, setHasPrev] = useState(false);
  const totalPages = total ? Math.max(1, Math.ceil(total / limit)) : null;

  const [rows, setRows] = useState([]);
  const [selected, setSelected] = useState(null);

  const [refundReason, setRefundReason] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmittingRefund, setIsSubmittingRefund] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [reloadToken, setReloadToken] = useState(0);
  const lastFetchId = useRef(0);

  const apiRequest = useCallback(
    async (path, { method = "GET", body } = {}) => {
      const trimmedBase = String(apiBaseUrl || "").replace(/\/$/, "");
      if (!trimmedBase) throw new Error("API base URL is not configured.");

      const headers = { "Content-Type": "application/json" };
      if (authToken) headers.Authorization = `Bearer ${authToken}`;

      const response = await fetch(`${trimmedBase}${path}`, {
        method,
        headers: { ...headers, ...getActorHeaders(authUser) },
        credentials: getFetchCredentials(),
        body: body ? JSON.stringify(body) : undefined,
      });

      const payload = await readJsonSafely(response);
      if (!response.ok) {
        const message =
          (payload && (payload.message || payload.error)) ||
          `Request failed (HTTP ${response.status}).`;
        throw new Error(String(message));
      }

      return payload;
    },
    [apiBaseUrl, authToken, authUser],
  );

  useEffect(() => {
    if (showSalesTab) return;
    setActiveTab("refunds");
  }, [showSalesTab]);

  useEffect(() => {
    setPage(1);
    setSelected(null);
    setRefundReason("");
    setError("");
    setSuccess("");
  }, [activeTab, endDate, limit, q, startDate]);

  useEffect(() => {
    const selectedId = selected?.id;
    if (!selectedId) return;
    const nextSelected = rows.find((row) => row.id === selectedId) ?? null;
    if (!nextSelected) {
      setSelected(null);
      setRefundReason("");
      return;
    }
    setSelected(nextSelected);
  }, [rows, selected]);

  useEffect(() => {
    const start = dateFromIsoDateInput(startDate);
    const end = dateFromIsoDateInput(endDate);
    const clamped = clampDateRange({ start, end });
    if (!clamped.start || !clamped.end) return;

    const fetchId = ++lastFetchId.current;
    setIsLoading(true);
    setError("");

    (async () => {
      try {
        const from = formatIsoDateInput(clamped.start);
        const to = formatIsoDateInput(clamped.end);
        const commonParams = {
          q: q.trim() || undefined,
          page,
          limit,
          storeId: storeId || undefined,
          employeeId: cashierId || undefined,
          cashierId: cashierId || undefined,
          startDate: from,
          endDate: to,
          from,
          to,
        };

        const path =
          activeTab === "refunds"
            ? `/sales/refunds${buildQueryString(commonParams)}`
            : `/sales/reports/receipts${buildQueryString({
                ...commonParams,
                type: "sale",
              })}`;

        const payload = await apiRequest(path);
        const parsed = parsePagedResponse(payload, { page, limit });
        const list = extractList({ data: parsed.data })
          .map((row) => normalizeRecord(row, activeTab === "refunds" ? "refund" : "sale"))
          .filter(Boolean);

        const filteredRows =
          activeTab === "sales"
            ? list.filter((row) => row.type === "sale")
            : list.filter((row) => row.type === "refund" || row.originalSaleId || row.reason);

        if (fetchId !== lastFetchId.current) return;
        setRows(filteredRows);
        setTotal(
          parsed.total ??
            (!parsed.hasNext && page === 1 ? filteredRows.length : null),
        );
        setHasNext(Boolean(parsed.hasNext));
        setHasPrev(Boolean(parsed.hasPrev));
      } catch (e) {
        if (fetchId !== lastFetchId.current) return;
        setRows([]);
        setTotal(null);
        setHasNext(false);
        setHasPrev(false);
        setError(e instanceof Error ? e.message : "Failed to load refunds.");
      } finally {
        if (fetchId === lastFetchId.current) setIsLoading(false);
      }
    })();
  }, [activeTab, apiRequest, cashierId, endDate, limit, page, q, reloadToken, startDate, storeId]);

  const rangeLabel = useMemo(() => {
    const start = dateFromIsoDateInput(startDate);
    const end = dateFromIsoDateInput(endDate);
    const clamped = clampDateRange({ start, end });
    if (!clamped.start || !clamped.end) return "--";
    return `${formatIsoDateInput(clamped.start)} - ${formatIsoDateInput(clamped.end)}`;
  }, [endDate, startDate]);

  const selectedCanRefund =
    allowRefund &&
    activeTab === "sales" &&
    Boolean(selected) &&
    selected?.type === "sale" &&
    !selected?.refunded &&
    !isSubmittingRefund;

  const selectedStatusLabel = useMemo(() => {
    if (!selected) return "--";
    if (selected.type === "refund") return "Refund";
    if (selected.refunded) return "Refunded sale";
    return "Sale";
  }, [selected]);

  const handleRefund = useCallback(async () => {
    if (!selectedCanRefund || !selected) return;

    setIsSubmittingRefund(true);
    setError("");
    setSuccess("");

    try {
      const trimmedReason = refundReason.trim();
      await apiRequest(`/sales/${encodeURIComponent(selected.id)}/refund`, {
        method: "POST",
        body: trimmedReason ? { reason: trimmedReason } : {},
      });

      setSuccess(`Refund created for ${selected.receiptNo || selected.id}.`);
      setRefundReason("");
      setSelected(null);
      setPage(1);
      setActiveTab("refunds");
      setReloadToken((value) => value + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create refund.");
    } finally {
      setIsSubmittingRefund(false);
    }
  }, [apiRequest, refundReason, selected, selectedCanRefund]);

  return (
    <div className="page receiptsReportPage">
      <div className="salesSummaryHeaderBar" aria-label="Refunds">
        <div className="salesSummaryHeaderTitle">Refunds</div>
      </div>

      <div className="card salesSummaryFiltersCard cashierRefundsFiltersCard">
        <div className="cashierRefundsTopRow">
          <div className="cashierRefundsTabs" role="tablist" aria-label="Refund views">
            {showSalesTab ? (
              <button
                type="button"
                className={`cashierRefundsTabBtn ${
                  activeTab === "sales" ? "cashierRefundsTabBtnActive" : ""
                }`}
                onClick={() => setActiveTab("sales")}
                aria-selected={activeTab === "sales"}
              >
                Refund Sale
              </button>
            ) : null}
            <button
              type="button"
              className={`cashierRefundsTabBtn ${
                activeTab === "refunds" ? "cashierRefundsTabBtnActive" : ""
              }`}
              onClick={() => setActiveTab("refunds")}
              aria-selected={activeTab === "refunds"}
            >
              Refund History
            </button>
          </div>

          <div className="cashierRefundsStoreTag" title={storeLabel}>
            Store: {storeLabel}
          </div>
        </div>

        <div className="salesSummaryFilters">
          <div className="salesSummaryFilterGroup" aria-label="Date range">
            <button
              className="salesSummaryRangeBtn"
              type="button"
              aria-label="Previous period"
              onClick={() => {
                const start = dateFromIsoDateInput(startDate);
                const end = dateFromIsoDateInput(endDate);
                const clamped = clampDateRange({ start, end });
                if (!clamped.start || !clamped.end) return;
                const days = Math.max(1, Math.round((clamped.end - clamped.start) / 86400000) + 1);
                setStartDate(formatIsoDateInput(addDays(clamped.start, -days)));
                setEndDate(formatIsoDateInput(addDays(clamped.end, -days)));
              }}
              disabled={isLoading || isSubmittingRefund}
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
                disabled={isLoading || isSubmittingRefund}
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
                disabled={isLoading || isSubmittingRefund}
              />
            </div>

            <button
              className="salesSummaryRangeBtn"
              type="button"
              aria-label="Next period"
              onClick={() => {
                const start = dateFromIsoDateInput(startDate);
                const end = dateFromIsoDateInput(endDate);
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
              disabled={
                isLoading ||
                isSubmittingRefund ||
                (todayKey && endDate && endDate >= todayKey)
              }
            >
              {">"}
            </button>
          </div>

          <div className="salesSummaryFiltersRight">
            <div className="salesByItemRangeMeta" title={rangeLabel}>
              {rangeLabel}
            </div>
          </div>
        </div>
      </div>

      {success ? <div className="authSuccess">{success}</div> : null}
      {error ? <div className="authError salesSummaryError">{error}</div> : null}

      <div className="receiptsReportContent">
        <div className="receiptsReportMain">
          <div className="card salesSummaryTableCard">
            <div className="salesSummaryTableHeader">
              <div className="salesSummaryExportLabel">
                {activeTab === "sales" ? "REFUNDABLE SALES" : "REFUND HISTORY"}
              </div>

              <div className="receiptsReportHeaderRight">
                <input
                  className="receiptsSearchInput"
                  type="search"
                  placeholder={
                    activeTab === "sales"
                      ? "Search receipt or customer"
                      : "Search refund receipt or customer"
                  }
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  disabled={isLoading || isSubmittingRefund}
                  aria-label="Search refunds"
                />
                <button
                  className="btn btnGhost btnSmall"
                  type="button"
                  onClick={() => setReloadToken((value) => value + 1)}
                  disabled={isLoading || isSubmittingRefund}
                >
                  Refresh
                </button>
              </div>
            </div>

            <div className="tableWrap">
              <table className="table receiptsTable" aria-label="Refunds table">
                <thead>
                  <tr>
                    <th className="receiptsColNo">Receipt no.</th>
                    <th className="receiptsColDate">Date</th>
                    <th className="receiptsColCustomer">Customer</th>
                    <th className="receiptsColType">Status</th>
                    <th className="colMoney">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="usersEmpty">
                        {isLoading
                          ? "Loading..."
                          : activeTab === "sales"
                            ? "No sales available for refund."
                            : "No refunds found."}
                      </td>
                    </tr>
                  ) : (
                    rows.map((row) => (
                      <tr
                        key={row.id}
                        className={`receiptsRow ${
                          selected?.id === row.id ? "receiptsRowActive" : ""
                        }`}
                        onClick={() => {
                          setSelected(row);
                          setSuccess("");
                        }}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            setSelected(row);
                            setSuccess("");
                          }
                        }}
                      >
                        <td className="receiptsColNo">{row.receiptNo || row.id}</td>
                        <td className="receiptsColDate">{formatReceiptDate(row.date)}</td>
                        <td className="receiptsColCustomer">{row.customer || "Walk-in"}</td>
                        <td className="receiptsColType">
                          {row.type === "refund"
                            ? "Refund"
                            : row.refunded
                              ? "Refunded sale"
                              : "Sale"}
                        </td>
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
                  disabled={!hasPrev || page <= 1 || isLoading || isSubmittingRefund}
                  onClick={() => setPage((value) => Math.max(1, value - 1))}
                >
                  {"<"}
                </button>
                <button
                  className="pagerBtn"
                  type="button"
                  aria-label="Next page"
                  disabled={
                    !hasNext ||
                    isLoading ||
                    isSubmittingRefund
                  }
                  onClick={() =>
                    setPage((value) =>
                      totalPages ? Math.min(totalPages, value + 1) : value + 1,
                    )
                  }
                >
                  {">"}
                </button>
              </div>

              <div className="pagerMeta">
                <span>Page:</span>
                <span className="salesSummaryPagerStrong">{page}</span>
                <span>of {totalPages ?? "--"}</span>
              </div>

              <div className="pagerMeta">
                <span>Rows per page:</span>
                <select
                  className="select selectSmall"
                  value={String(limit)}
                  onChange={(e) => setLimit(toPositiveInt(e.target.value, limit))}
                  disabled={isLoading || isSubmittingRefund}
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
            <div className="receiptsDrawerBody" role="dialog" aria-label="Refund details">
              <div className="receiptsDrawerTop">
                <button
                  className="receiptsDrawerClose"
                  type="button"
                  aria-label="Close details"
                  onClick={() => {
                    setSelected(null);
                    setRefundReason("");
                  }}
                >
                  ×
                </button>
              </div>

              <div className="receiptsDrawerTotal">{formatMoney(selected.total)}</div>
              <div className="receiptsDrawerTotalLabel">
                {activeTab === "sales" ? "Sale total" : "Refund total"}
              </div>

              <div className="receiptsDrawerDivider" aria-hidden="true" />

              <div className="receiptsDrawerMeta">
                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">Receipt no.</span>
                  <span className="receiptsDrawerMetaValue">
                    {selected.receiptNo || selected.id}
                  </span>
                </div>

                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">Date</span>
                  <span className="receiptsDrawerMetaValue">
                    {formatReceiptDate(selected.date)}
                  </span>
                </div>

                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">Customer</span>
                  <span className="receiptsDrawerMetaValue">
                    {selected.customer || "Walk-in"}
                  </span>
                </div>

                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">Employee</span>
                  <span className="receiptsDrawerMetaValue">
                    {selected.employee || "--"}
                  </span>
                </div>

                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">Status</span>
                  <span className="receiptsDrawerMetaValue">{selectedStatusLabel}</span>
                </div>

                {selected.originalSaleId ? (
                  <div className="receiptsDrawerMetaRow">
                    <span className="receiptsDrawerMetaLabel">Original sale</span>
                    <span className="receiptsDrawerMetaValue">{selected.originalSaleId}</span>
                  </div>
                ) : null}

                {selected.reason ? (
                  <div className="receiptsDrawerMetaRow cashierRefundsMetaRowBlock">
                    <span className="receiptsDrawerMetaLabel">Reason</span>
                    <span className="receiptsDrawerMetaValue cashierRefundsReasonValue">
                      {selected.reason}
                    </span>
                  </div>
                ) : null}
              </div>

              {selected.items?.length ? (
                <>
                  <div className="receiptsDrawerDivider" aria-hidden="true" />
                  <div className="cashierRefundsItemsBlock">
                    <div className="receiptsDrawerMetaLabel">Items</div>
                    <div className="cashierRefundsItemsList" role="list" aria-label="Refund items">
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

              {selected.type === "sale" && selected.refunded ? (
                <>
                  <div className="receiptsDrawerDivider" aria-hidden="true" />
                  <div className="salesSummaryHint">
                    This sale already has a linked refund and cannot be refunded again.
                  </div>
                </>
              ) : null}

              {selectedCanRefund ? (
                <>
                  <div className="receiptsDrawerDivider" aria-hidden="true" />
                  <div className="cashierRefundsActionBlock">
                    <label className="fieldLabel" htmlFor="refund-reason">
                      Refund reason
                    </label>
                    <textarea
                      id="refund-reason"
                      className="textarea cashierRefundsReasonInput"
                      placeholder="Optional reason for the refund"
                      value={refundReason}
                      onChange={(e) => setRefundReason(e.target.value)}
                      disabled={isSubmittingRefund}
                      rows={4}
                    />
                    <button
                      className="btn btnPrimary cashierRefundsSubmitBtn"
                      type="button"
                      onClick={handleRefund}
                      disabled={isSubmittingRefund}
                    >
                      {isSubmittingRefund ? "Processing..." : "Refund sale"}
                    </button>
                  </div>
                </>
              ) : null}
            </div>
          ) : (
            <div className="receiptsDrawerEmpty">
              {activeTab === "sales"
                ? "Select a sale to review or refund it."
                : "Select a refund to view its details."}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
