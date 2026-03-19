import { useCallback, useEffect, useMemo, useState } from "react";

import fallbackItems from "../data/items.json";
import {
  buildQueryString,
  getActorHeaders,
  getFetchCredentials,
  makeId,
  parsePagedResponse,
  readLocalStorage,
  resolveStoreId,
  safeParseList,
  toPositiveInt,
  writeLocalStorage,
} from "../utils/common.js";
import { useStoresList } from "../utils/stores.js";
import { SearchIcon, UsersIcon } from "../icons/index.jsx";

const moneyFormatter = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const API_ITEMS_LIMIT_CAP = 100;

function formatMoney(value) {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) return "—";
  return moneyFormatter.format(numberValue);
}

async function readJsonSafely(response) {
  try {
    return await response.json();
  } catch {
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

function extractCustomersList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.customers)) return payload.customers;
  if (Array.isArray(payload?.data?.customers)) return payload.data.customers;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.data?.results)) return payload.data.results;
  return [];
}

function extractDiscountsList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.discounts)) return payload.discounts;
  if (Array.isArray(payload?.data?.discounts)) return payload.data.discounts;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.data?.results)) return payload.data.results;
  return [];
}

function resolveImageUrl(apiBaseUrl, value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^(https?:|data:|blob:)/i.test(raw)) return raw;
  const base = String(apiBaseUrl || "").replace(/\/$/, "");
  if (!base) return raw;
  return raw.startsWith("/") ? `${base}${raw}` : `${base}/${raw}`;
}

function toUiItem(apiItem, apiBaseUrl = "") {
  if (!apiItem || typeof apiItem !== "object") return null;
  const id =
    apiItem.id ??
    apiItem._id ??
    apiItem.itemId ??
    apiItem.uuid ??
    (apiItem.name ? `name:${apiItem.name}` : null);
  if (!id) return null;

  const price = apiItem.price ?? null;
  const cost = apiItem.cost ?? apiItem.unitCost ?? apiItem.unit_cost ?? null;
  const inStockRaw = apiItem.inStock ?? apiItem.stock ?? apiItem.qty ?? null;
  const inStock =
    typeof inStockRaw === "number"
      ? inStockRaw
      : inStockRaw == null || inStockRaw === ""
        ? null
        : Number(inStockRaw);

  const trackStockRaw = apiItem.trackStock ?? apiItem.track_stock ?? null;
  const trackStock =
    trackStockRaw == null ? inStock != null : Boolean(trackStockRaw);

  const storeId =
    apiItem.storeId ??
    apiItem.store_id ??
    apiItem.assignedStoreId ??
    apiItem.assigned_store_id ??
    apiItem.store?.id ??
    apiItem.store?._id ??
    apiItem.store?.storeId ??
    "";

  return {
    id: String(id),
    name: String(apiItem.name ?? ""),
    category: (() => {
      const raw =
        apiItem.category ?? apiItem.categoryName ?? apiItem.category_name ?? "";
      if (raw && typeof raw === "object") return String(raw.name ?? "").trim();
      return String(raw ?? "").trim();
    })(),
    price:
      typeof price === "number"
        ? price
        : price == null || price === ""
          ? null
          : Number(price),
    cost:
      typeof cost === "number"
        ? cost
        : cost == null || cost === ""
          ? null
          : Number(cost),
    trackStock,
    inStock: Number.isFinite(inStock) ? inStock : null,
    storeId:
      typeof storeId === "string" || typeof storeId === "number"
        ? String(storeId)
        : "",
    imageUrl: resolveImageUrl(
      apiBaseUrl,
      apiItem.imageUrl ?? apiItem.image_url ?? apiItem.image?.url ?? "",
    ),
  };
}

function toUiCustomer(apiCustomer) {
  if (!apiCustomer || typeof apiCustomer !== "object") return null;
  const id =
    apiCustomer.id ??
    apiCustomer._id ??
    apiCustomer.customerId ??
    apiCustomer.uuid ??
    (apiCustomer.email ? `email:${apiCustomer.email}` : null);
  if (!id) return null;

  const name =
    typeof apiCustomer.name === "string"
      ? apiCustomer.name
      : typeof apiCustomer.fullName === "string"
        ? apiCustomer.fullName
        : typeof apiCustomer.customerName === "string"
          ? apiCustomer.customerName
          : "";

  const email =
    typeof apiCustomer.email === "string"
      ? apiCustomer.email
      : typeof apiCustomer.customerEmail === "string"
        ? apiCustomer.customerEmail
        : "";

  const storeId =
    apiCustomer.storeId ??
    apiCustomer.store_id ??
    apiCustomer.assignedStoreId ??
    apiCustomer.assigned_store_id ??
    apiCustomer.store?.id ??
    apiCustomer.store?._id ??
    apiCustomer.store?.storeId ??
    "";

  return {
    id: String(id),
    name: String(name || "").trim(),
    email: String(email || "").trim(),
    storeId:
      typeof storeId === "string" || typeof storeId === "number"
        ? String(storeId)
        : "",
  };
}

function toUiDiscount(apiDiscount) {
  if (!apiDiscount || typeof apiDiscount !== "object") return null;

  const id =
    apiDiscount.id ??
    apiDiscount._id ??
    apiDiscount.discountId ??
    apiDiscount.uuid ??
    (apiDiscount.name ? `name:${apiDiscount.name}` : null);
  if (!id) return null;

  const typeRaw =
    apiDiscount.type ?? apiDiscount.discountType ?? apiDiscount.kind ?? "percentage";
  const type = String(typeRaw).toLowerCase() === "amount" ? "amount" : "percentage";
  const value = apiDiscount.value ?? apiDiscount.amount ?? apiDiscount.percent ?? null;

  return {
    id: String(id),
    name: String(apiDiscount.name ?? ""),
    type,
    value: value == null || value === "" ? null : Number(value),
    restrictedAccess: Boolean(
      apiDiscount.restrictedAccess ?? apiDiscount.restricted_access,
    ),
  };
}

function calcDiscountAmount(discount, subtotal) {
  const base = typeof subtotal === "number" ? subtotal : Number(subtotal);
  if (!Number.isFinite(base) || base <= 0) return 0;
  if (!discount) return 0;

  const raw = discount.value;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;

  const amount = discount.type === "amount" ? value : (base * value) / 100;
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.min(base, amount);
}

function calcCartTotal(cartById) {
  let total = 0;
  for (const line of Object.values(cartById)) {
    if (!line) continue;
    const price =
      typeof line.price === "number" ? line.price : Number(line.price);
    if (!Number.isFinite(price)) continue;
    total += price * (line.qty || 0);
  }
  return total;
}

function calcCartCount(cartById) {
  let count = 0;
  for (const line of Object.values(cartById)) {
    if (!line) continue;
    count += line.qty || 0;
  }
  return count;
}

export default function CashierPosPage({ apiBaseUrl, authToken, authUser }) {
  const name =
    authUser?.name || authUser?.fullName || authUser?.email || "Cashier";
  const storeId = resolveStoreId(authUser);
  const cashierId = useMemo(() => {
    if (!authUser || typeof authUser !== "object") return "";
    const raw =
      authUser.id ?? authUser._id ?? authUser.userId ?? authUser.uuid ?? "";
    return typeof raw === "string" || typeof raw === "number"
      ? String(raw)
      : "";
  }, [authUser]);

  const [items, setItems] = useState([]);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const [itemsPage, setItemsPage] = useState(1);
  const [itemsLimit, setItemsLimit] = useState(100);
  const [itemsTotal, setItemsTotal] = useState(null);
  const [itemsHasNext, setItemsHasNext] = useState(false);
  const [itemsHasPrev, setItemsHasPrev] = useState(false);
  const [itemsPageInput, setItemsPageInput] = useState("1");

  const [category, setCategory] = useState("all");
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");

  const [cartOpen, setCartOpen] = useState(false);
  const [cartById, setCartById] = useState({});
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [cashReceived, setCashReceived] = useState("");
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [receiptEmail, setReceiptEmail] = useState("");
  const [lastSale, setLastSale] = useState(null);
  const [saleError, setSaleError] = useState("");
  const [isSubmittingSale, setIsSubmittingSale] = useState(false);

  const [customerPickerOpen, setCustomerPickerOpen] = useState(false);
  const [customers, setCustomers] = useState([]);
  const [customersError, setCustomersError] = useState("");
  const [isCustomersLoading, setIsCustomersLoading] = useState(false);
  const [customerSearch, setCustomerSearch] = useState("");
  const [selectedCustomer, setSelectedCustomer] = useState(null);

  const [discounts, setDiscounts] = useState([]);
  const [discountsError, setDiscountsError] = useState("");
  const [isDiscountsLoading, setIsDiscountsLoading] = useState(false);
  const [selectedDiscountId, setSelectedDiscountId] = useState("");

  const [storeNameOverride, setStoreNameOverride] = useState("");

  const authHeaders = useMemo(() => {
    const headers = { "Content-Type": "application/json" };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    return { ...headers, ...getActorHeaders(authUser) };
  }, [authToken, authUser]);

  const apiRequest = useCallback(
    async (path, { method = "GET", body } = {}) => {
      if (!apiBaseUrl) throw new Error("API base URL is not configured.");
      const trimmedBase = String(apiBaseUrl).replace(/\/$/, "");
      const response = await fetch(`${trimmedBase}${path}`, {
        method,
        credentials: getFetchCredentials(),
        headers: authHeaders,
        body: body ? JSON.stringify(body) : undefined,
      });

      const payload = await readJsonSafely(response);
      if (!response.ok) {
        const apiMessage =
          (payload && (payload.message || payload.error)) ||
          `Request failed (HTTP ${response.status}).`;
        throw new Error(String(apiMessage));
      }
      return payload;
    },
    [apiBaseUrl, authHeaders],
  );

  const { stores: storesList } = useStoresList({ apiBaseUrl, apiRequest });

  const storeName = useMemo(() => {
    if (!storeId) return "";

    const storeRaw =
      authUser?.storeName ??
      authUser?.store_name ??
      authUser?.store?.name ??
      authUser?.store?.storeName ??
      authUser?.store?.label ??
      "";
    const fromUser = String(storeRaw ?? "").trim();
    if (fromUser) return fromUser;

    const match =
      storesList.find((s) => String(s?.id ?? "") === String(storeId)) ?? null;
    if (match?.name) return String(match.name);

    const storesFromStorage = safeParseList(readLocalStorage("pos.stores.v1", ""));
    const fallback = storesFromStorage.find(
      (s) => String(s?.id ?? "") === String(storeId),
    );
    return fallback?.name ? String(fallback.name) : "";
  }, [authUser, storeId, storesList]);

  useEffect(() => {
    if (!storeId) return;
    if (storeName) return;
    if (storeNameOverride) return;

    let cancelled = false;
    (async () => {
      try {
        const payload = await apiRequest(`/stores/${encodeURIComponent(storeId)}`);
        const data = payload?.data ?? payload?.store ?? payload;
        const fetchedName = String(data?.name ?? "").trim();
        if (!fetchedName) return;
        if (cancelled) return;
        setStoreNameOverride(fetchedName);

        const storesFromStorage = safeParseList(readLocalStorage("pos.stores.v1", ""));
        const next = storesFromStorage.filter(
          (s) => String(s?.id ?? "") !== String(storeId),
        );
        next.push({ id: String(storeId), name: fetchedName });
        writeLocalStorage("pos.stores.v1", JSON.stringify(next));
      } catch {
        // ignore: cashier might not be allowed to fetch stores
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [apiRequest, storeId, storeName, storeNameOverride]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setIsLoading(true);
      setError("");
      try {
        const apiLimit = Math.min(itemsLimit, API_ITEMS_LIMIT_CAP);
        const pagesPerUiPage = Math.max(1, Math.ceil(itemsLimit / apiLimit));
        const apiStartPage = (itemsPage - 1) * pagesPerUiPage + 1;
        const trimmedSearch = search.trim();
        const categoryParam = category !== "all" ? category : undefined;

        async function fetchItemsPage(page) {
          const qs = buildQueryString({
            storeId: storeId || undefined,
            page,
            limit: apiLimit,
            search: trimmedSearch || undefined,
            category: categoryParam,
          });

          try {
            return await apiRequest(`/items${qs}`);
          } catch (e) {
            if (!storeId) throw e;
            const fallbackQs = buildQueryString({
              page,
              limit: apiLimit,
              search: trimmedSearch || undefined,
              category: categoryParam,
            });
            return await apiRequest(`/items${fallbackQs}`);
          }
        }

        const combined = [];
        let total = null;
        let lastHasNext = null;
        let lastPayload = null;

        for (let i = 0; i < pagesPerUiPage; i += 1) {
          const page = apiStartPage + i;
          const payload = await fetchItemsPage(page);
          lastPayload = payload;

          const parsed = parsePagedResponse(payload, { page, limit: apiLimit });
          if (total == null && parsed.total != null) total = parsed.total;

          const data = extractItemsList({ ...payload, data: parsed.data });
          const mapped = data.map((item) => toUiItem(item, apiBaseUrl)).filter(Boolean);
          combined.push(...mapped);

          if (typeof parsed.hasNext === "boolean") lastHasNext = parsed.hasNext;
          if (mapped.length < apiLimit) break;
        }

        const list = combined.slice(0, itemsLimit);
        if (cancelled) return;
        setItems(list);
        setItemsTotal(total);

        const inferredHasNext =
          total != null
            ? itemsPage * itemsLimit < total
            : typeof lastHasNext === "boolean"
              ? lastHasNext
              : typeof lastPayload?.hasNext === "boolean"
                ? lastPayload.hasNext
                : typeof lastPayload?.has_next === "boolean"
                  ? lastPayload.has_next
                  : list.length === itemsLimit;

        setItemsHasPrev(itemsPage > 1);
        setItemsHasNext(Boolean(inferredHasNext));
        setItemsPageInput(String(itemsPage));
      } catch (e) {
        if (cancelled) return;
        const list = (Array.isArray(fallbackItems) ? fallbackItems : [])
          .map((item) => toUiItem(item, apiBaseUrl))
          .filter(Boolean);
        setItems(list);
        setItemsTotal(list.length);
        setItemsHasNext(false);
        setItemsHasPrev(false);
        setItemsPage(1);
        setItemsPageInput("1");
        setError(e instanceof Error ? e.message : "Failed to load items.");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [apiRequest, storeId, itemsLimit, itemsPage, search, category]);

  useEffect(() => {
    if (itemsPage !== 1) setItemsPage(1);
    if (itemsPageInput !== "1") setItemsPageInput("1");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, search, storeId]);

  useEffect(() => {
    let cancelled = false;

    async function loadCustomers() {
      setIsCustomersLoading(true);
      setCustomersError("");
      try {
        const qs = buildQueryString({ limit: 200 });
        const payload = await apiRequest(`/customers${qs}`);

        const list = extractCustomersList(payload)
          .map(toUiCustomer)
          .filter(Boolean);
        if (cancelled) return;
        setCustomers(list);
      } catch (e) {
        if (cancelled) return;
        const fallback = safeParseList(readLocalStorage("pos.customers.v1", ""))
          .map(toUiCustomer)
          .filter(Boolean);
        setCustomers(fallback);
        setCustomersError(
          e instanceof Error ? e.message : "Failed to load customers.",
        );
      } finally {
        if (!cancelled) setIsCustomersLoading(false);
      }
    }

    loadCustomers();
    return () => {
      cancelled = true;
    };
  }, [apiRequest]);

  useEffect(() => {
    let cancelled = false;

    async function loadDiscounts() {
      setIsDiscountsLoading(true);
      setDiscountsError("");
      try {
        const qs = buildQueryString({ limit: 200 });
        const payload = await apiRequest(`/discounts${qs}`);

        const list = extractDiscountsList(payload)
          .map(toUiDiscount)
          .filter(Boolean);
        if (cancelled) return;
        setDiscounts(list);
      } catch (e) {
        if (cancelled) return;
        const fallback = safeParseList(readLocalStorage("pos.discounts.v1", ""))
          .map(toUiDiscount)
          .filter(Boolean);
        setDiscounts(fallback);
        setDiscountsError(
          e instanceof Error ? e.message : "Failed to load discounts.",
        );
      } finally {
        if (!cancelled) setIsDiscountsLoading(false);
      }
    }

    loadDiscounts();
    return () => {
      cancelled = true;
    };
  }, [apiRequest]);

  const availableCategories = useMemo(() => {
    const unique = new Set();
    for (const item of items) {
      if (item?.category) unique.add(String(item.category));
    }
    return Array.from(unique)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  }, [items]);

  const filteredItems = useMemo(() => {
    const query = search.trim().toLowerCase();

    const hasStoreTaggedItems = Boolean(
      storeId &&
      items.some(
        (item) => item?.storeId && String(item.storeId) === String(storeId),
      ),
    );

    return items
      .filter((item) => {
        if (!item) return false;
        if (
          item.trackStock &&
          typeof item.inStock === "number" &&
          Number.isFinite(item.inStock) &&
          item.inStock <= 0
        ) {
          return false;
        }
        if (
          hasStoreTaggedItems &&
          storeId &&
          item.storeId &&
          String(item.storeId) !== String(storeId)
        ) {
          return false;
        }
        if (
          category !== "all" &&
          String(item.category || "") !== String(category)
        )
          return false;
        if (!query) return true;
        return (
          String(item.name || "")
            .toLowerCase()
            .includes(query) ||
          String(item.category || "")
            .toLowerCase()
            .includes(query)
        );
      });
  }, [items, category, search, storeId]);

  const itemsTotalPages = useMemo(() => {
    if (itemsTotal == null) return null;
    const pages = Math.ceil(itemsTotal / Math.max(1, itemsLimit));
    return Math.max(1, pages);
  }, [itemsLimit, itemsTotal]);

  const cartSubtotal = useMemo(() => calcCartTotal(cartById), [cartById]);
  const cartCount = useMemo(() => calcCartCount(cartById), [cartById]);

  const selectedDiscount = useMemo(() => {
    if (!selectedDiscountId) return null;
    return discounts.find((d) => String(d.id) === String(selectedDiscountId)) || null;
  }, [discounts, selectedDiscountId]);

  const discountAmount = useMemo(() => {
    return calcDiscountAmount(selectedDiscount, cartSubtotal);
  }, [selectedDiscount, cartSubtotal]);

  const cartTotal = useMemo(() => {
    return Math.max(0, cartSubtotal - discountAmount);
  }, [cartSubtotal, discountAmount]);

  const filteredCustomers = useMemo(() => {
    const query = customerSearch.trim().toLowerCase();

    const hasStoreTaggedCustomers = Boolean(
      storeId &&
      customers.some(
        (c) => c?.storeId && String(c.storeId) === String(storeId),
      ),
    );

    return customers
      .filter((c) => {
        if (!c) return false;
        if (
          hasStoreTaggedCustomers &&
          storeId &&
          c.storeId &&
          String(c.storeId) !== String(storeId)
        ) {
          return false;
        }
        if (!query) return true;
        return (
          String(c.name || "")
            .toLowerCase()
            .includes(query) ||
          String(c.email || "")
            .toLowerCase()
            .includes(query)
        );
      })
      .slice(0, 200);
  }, [customers, customerSearch, storeId]);

  function addToCart(item) {
    if (!item) return;
    setCartById((prev) => {
      const existing = prev[item.id];
      const nextQty = (existing?.qty || 0) + 1;
      return {
        ...prev,
        [item.id]: {
          id: item.id,
          name: item.name,
          price: item.price ?? 0,
          cost: item.cost ?? null,
          qty: nextQty,
        },
      };
    });
  }

  function setCartQty(lineId, nextQty) {
    setCartById((prev) => {
      const current = prev[lineId];
      if (!current) return prev;
      const qty = Math.max(0, Math.trunc(Number(nextQty) || 0));
      if (qty <= 0) {
        const { [lineId]: _, ...rest } = prev;
        return rest;
      }
      return { ...prev, [lineId]: { ...current, qty } };
    });
  }

  function openCheckout() {
    if (cartCount <= 0) return;
    setCashReceived(cartTotal ? cartTotal.toFixed(2) : "");
    setSaleError("");
    setCheckoutOpen(true);
    setCartOpen(false);
  }

  function buildSalePayload({
    paymentType,
    amountPaid,
    change,
    cashReceivedAmount,
  }) {
    const saleId = makeId("sale");
    const items = Object.values(cartById)
      .filter(Boolean)
      .map((line) => {
        const price =
          typeof line.price === "number" ? line.price : Number(line.price);
        const cost = typeof line.cost === "number" ? line.cost : Number(line.cost);
        const qty = Math.max(0, Math.trunc(Number(line.qty) || 0));
        const unitPrice = Number.isFinite(price) ? price : 0;
        const unitCost = Number.isFinite(cost) ? cost : null;
        return {
          itemId: line.id,
          name: line.name,
          unitPrice,
          unitCost,
          qty,
          lineTotal: unitPrice * qty,
        };
      })
      .filter((line) => line.qty > 0);

    const apiPayload = {
      id: saleId,
      items: items.map((line) => ({
        itemId: line.itemId,
        qty: line.qty,
        unitPrice: line.unitPrice,
        ...(line.unitCost != null ? { unitCost: line.unitCost, cost: line.unitCost } : null),
        name: line.name,
      })),
      discounts: selectedDiscount
        ? [
            {
              id: String(selectedDiscount.id),
              discountId: String(selectedDiscount.id),
              name: String(selectedDiscount.name ?? ""),
              type: String(selectedDiscount.type ?? ""),
              value: selectedDiscount.value ?? null,
              amount: discountAmount,
            },
          ]
        : [],
      payment: {
        type: paymentType,
        cashReceived: paymentType === "cash" ? cashReceivedAmount : undefined,
      },
      totals: {
        subtotal: cartSubtotal,
        discount: discountAmount,
        amountDue: cartTotal,
        amountPaid,
        change,
      },
      currency: "PHP",
      customerId: selectedCustomer?.id
        ? String(selectedCustomer.id)
        : undefined,
      email: selectedCustomer?.email?.trim()
        ? String(selectedCustomer.email).trim()
        : undefined,
    };

    const uiPayload = {
      id: saleId,
      storeId: storeId || null,
      cashierId: cashierId || null,
      customer: selectedCustomer
        ? {
            id: selectedCustomer.id,
            name: selectedCustomer.name || null,
            email: selectedCustomer.email || null,
          }
        : null,
      currency: "PHP",
      totals: { ...apiPayload.totals, subtotal: cartSubtotal, discount: discountAmount },
      payment: {
        type: paymentType,
        cashReceived: paymentType === "cash" ? cashReceivedAmount : null,
      },
      discount: selectedDiscount
        ? {
            id: selectedDiscount.id,
            name: selectedDiscount.name,
            type: selectedDiscount.type,
            value: selectedDiscount.value,
          }
        : null,
      items,
      createdAt: new Date().toISOString(),
    };

    return { apiPayload, uiPayload };
  }

  async function completePayment(method) {
    if (cartCount <= 0) return;
    if (isSubmittingSale) return;

    if (method === "cash") {
      const received = Number(cashReceived);
      if (Number.isFinite(received) && received < cartTotal) {
        const ok = window.confirm(
          "Cash received is less than the total. Continue anyway?",
        );
        if (!ok) return;
      }
    }

    const ok = window.confirm(
      `Confirm ${method.toUpperCase()} payment of ${formatMoney(cartTotal)}?`,
    );
    if (!ok) return;

    setSaleError("");
    setIsSubmittingSale(true);

    const paymentType = method === "cash" ? "cash" : "card";
    const received = Number(cashReceived);
    const cashReceivedAmount =
      paymentType === "cash" && Number.isFinite(received) ? received : null;
    const amountPaid =
      paymentType === "cash" ? (cashReceivedAmount ?? cartTotal) : cartTotal;
    const change =
      paymentType === "cash" ? Math.max(0, amountPaid - cartTotal) : 0;

    const { apiPayload, uiPayload } = buildSalePayload({
      paymentType,
      amountPaid,
      change,
      cashReceivedAmount,
    });
    console.log("POS sale payload (API):", apiPayload);

    try {
      await apiRequest("/sales", { method: "POST", body: apiPayload });

      setLastSale({ payload: uiPayload, paymentType, amountPaid, change });

      setCartById({});
      setCheckoutOpen(false);
      setCartOpen(false);
      setReceiptEmail("");
      setReceiptOpen(true);
      setSearch("");
      setSearchOpen(false);
      setCategory("all");
      setSelectedDiscountId("");
    } catch (e) {
      setSaleError(e instanceof Error ? e.message : "Failed to save sale.");
    } finally {
      setIsSubmittingSale(false);
    }
  }

  if (receiptOpen && lastSale) {
    return (
      <div
        className="posReceiptOverlay"
        role="dialog"
        aria-modal="true"
        aria-label="Payment complete"
      >
        <div className="posReceiptBody">
          <div className="posReceiptStats" aria-label="Totals">
            <div className="posReceiptStat">
              <div className="posReceiptValue">
                {formatMoney(lastSale.amountPaid)}
              </div>
              <div className="posReceiptLabel">Total paid</div>
            </div>
            <div className="posReceiptDivider" aria-hidden="true" />
            <div className="posReceiptStat">
              <div className="posReceiptValue">
                {formatMoney(lastSale.change)}
              </div>
              <div className="posReceiptLabel">Change</div>
            </div>
          </div>

          <div className="posReceiptMeta">
            <div className="posReceiptPaymentType">
              Payment type:{" "}
              <span className="posReceiptPaymentValue">
                {lastSale.paymentType}
              </span>
            </div>
          </div>

          <div className="posReceiptEmailRow" aria-label="Email receipt">
            <input
              className="posReceiptEmailInput"
              type="email"
              placeholder="Enter email"
              value={receiptEmail}
              onChange={(e) => setReceiptEmail(e.target.value)}
              autoComplete="email"
            />
            <button
              type="button"
              className="posReceiptSendBtn"
              aria-label="Send receipt"
              onClick={async () => {
                const email = receiptEmail.trim();
                if (!email) return;
                setSaleError("");
                setIsSubmittingSale(true);
                try {
                  await apiRequest(
                    `/sales/${encodeURIComponent(lastSale.payload.id)}`,
                    {
                      method: "PATCH",
                      body: { email },
                    },
                  );
                  const payload = {
                    ...lastSale.payload,
                    customer: { ...(lastSale.payload.customer || {}), email },
                  };
                  console.log("POS sale payload (with email):", payload);
                  window.alert(
                    "Email saved. Receipt sending can be wired next.",
                  );
                } catch (e) {
                  setSaleError(
                    e instanceof Error
                      ? e.message
                      : "Failed to update sale email.",
                  );
                } finally {
                  setIsSubmittingSale(false);
                }
              }}
              disabled={!receiptEmail.trim() || isSubmittingSale}
            >
              ➤
            </button>
          </div>

          {saleError ? (
            <div className="authError posError">{saleError}</div>
          ) : null}

          <button
            type="button"
            className="posNewSaleBtn"
            onClick={() => {
              setReceiptOpen(false);
              setLastSale(null);
              setSelectedCustomer(null);
              setSelectedDiscountId("");
              setSaleError("");
            }}
          >
            ✓ NEW SALE
          </button>
        </div>
      </div>
    );
  }

  if (checkoutOpen) {
    return (
      <div
        className="posCheckoutOverlay"
        role="dialog"
        aria-modal="true"
        aria-label="Checkout"
      >
        <div className="posCheckoutTop">
          <button
            type="button"
            className="posCheckoutBack"
            onClick={() => setCheckoutOpen(false)}
            aria-label="Back"
          >
            ←
          </button>
          <div className="posCheckoutTopSpacer" />
        </div>

        <div className="posCheckoutBody">
          <div className="posCheckoutTotal">
            <div className="posCheckoutTotalAmount">
              {formatMoney(cartTotal)}
            </div>
            <div className="posCheckoutTotalSubtitle">Total amount due</div>
          </div>

          <div className="posCheckoutSection">
            <div className="posCheckoutLabel">Cash received</div>
            <input
              className="posCheckoutInput"
              inputMode="decimal"
              value={cashReceived}
              onChange={(e) => setCashReceived(e.target.value)}
              placeholder={cartTotal ? cartTotal.toFixed(2) : "0.00"}
              aria-label="Cash received"
            />
            <div className="posCheckoutDivider" aria-hidden="true" />
          </div>

          <div className="posCheckoutPayments" aria-label="Payment type">
            <button
              type="button"
              className="posPayBtn"
              onClick={() => completePayment("cash")}
              disabled={isSubmittingSale}
            >
              CASH
            </button>
            <button
              type="button"
              className="posPayBtn"
              onClick={() => completePayment("card")}
              disabled={isSubmittingSale}
            >
              CARD
            </button>
          </div>

          {saleError ? (
            <div className="authError posError">{saleError}</div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="page posPage">
      <div className="posHeader">
        <button
          type="button"
          className="posTicketBtn"
          onClick={() => setCartOpen(true)}
          aria-label="Open ticket"
        >
          <span className="posTicketLabel">Ticket</span>
          <span
            className="posTicketCount"
            aria-label={`Items in ticket: ${cartCount}`}
          >
            {cartCount}
          </span>
        </button>

        <div className="posHeaderMeta">
          <div className="posWelcome">Welcome, {String(name)}</div>
           {storeId ? (
             <div className="posStore">
               Store: {storeName || storeNameOverride || storeId}
             </div>
           ) : (
             <div className="posStore">Store: Unassigned</div>
           )}
          <div className="posStore">
            Customer:{" "}
            {selectedCustomer?.name || selectedCustomer?.email || "Walk-in"}
            {selectedCustomer ? (
              <button
                type="button"
                className="posClearCustomerBtn"
                onClick={() => setSelectedCustomer(null)}
                aria-label="Clear customer tag"
              >
                ×
              </button>
            ) : null}
          </div>
        </div>

        <div className="posHeaderActions">
          <button
            className={`iconButton iconButtonLight posCustomerBtn ${
              selectedCustomer ? "posCustomerBtnActive" : ""
            }`}
            type="button"
            aria-label="Tag customer"
            onClick={() => {
              setCustomerPickerOpen(true);
              setCustomerSearch("");
            }}
          >
            <UsersIcon className="posCustomerIcon" />
            <span className="posCustomerPlus" aria-hidden="true">
              +
            </span>
          </button>
        </div>
      </div>

      <button
        type="button"
        className="posChargeBtn"
        onClick={openCheckout}
        disabled={cartCount <= 0}
        aria-label={`Charge ${formatMoney(cartTotal)}`}
      >
        <div className="posChargeTitle">CHARGE</div>
        <div className="posChargeAmount">{formatMoney(cartTotal)}</div>
      </button>

      <div className="posToolbar" aria-label="Item filters">
        <select
          className="select posCategorySelect"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          aria-label="Category"
        >
          <option value="all">All items</option>
          {availableCategories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>

        <div className="posToolbarSpacer" />

        <button
          className="iconButton iconButtonLight"
          type="button"
          aria-label={searchOpen ? "Close search" : "Search items"}
          onClick={() => {
            setSearchOpen((s) => !s);
            if (searchOpen) setSearch("");
          }}
        >
          <SearchIcon className="searchIcon" />
        </button>
      </div>

      {searchOpen ? (
        <div className="posSearchRow" aria-label="Search">
          <input
            className="textInput posSearchInput"
            type="search"
            placeholder="Search items"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
        </div>
      ) : null}

      {error ? <div className="authError posError">{error}</div> : null}

      <div className="posItemsCard card" aria-label="Items list">
        <div className="posItemsHeader">
          <div className="posItemsTitle">Items</div>
          <div className="posItemsSubtitle">
            {isLoading
              ? "Loading…"
              : `${filteredItems.length} shown${
                  itemsTotal != null ? ` of ${itemsTotal}` : ""
                }`}
          </div>
        </div>

        <div className="posItemsList" role="list">
          {filteredItems.length === 0 ? (
            <div className="posEmpty">
              {isLoading ? "Loading…" : "No items found."}
            </div>
          ) : (
            filteredItems.map((item) => (
              <button
                key={item.id}
                type="button"
                className="posItemRow"
                onClick={() => addToCart(item)}
                aria-label={`Add ${item.name} to cart`}
              >
                <span className="posItemThumb" aria-hidden="true">
                  {item.imageUrl ? (
                    <img
                      className="posItemThumbImg"
                      src={item.imageUrl}
                      alt=""
                      loading="lazy"
                    />
                  ) : (
                    <span className="posItemThumbFallback">
                      {String(item.name || "?").trim().charAt(0).toUpperCase() || "?"}
                    </span>
                  )}
                </span>
                <span className="posItemMain">
                  <span className="posItemName">{item.name}</span>
                  {item.category ? (
                    <span className="posItemCategory">{item.category}</span>
                  ) : null}
                </span>
                <span className="posItemPrice">{formatMoney(item.price)}</span>
              </button>
            ))
          )}
        </div>

        <div className="itemListFooter" aria-label="Pagination">
          <div className="pagerButtons" aria-label="Page controls">
            <button
              className="pagerBtn"
              type="button"
              aria-label="Previous page"
              disabled={!itemsHasPrev || itemsPage <= 1 || isLoading}
              onClick={() => setItemsPage((p) => Math.max(1, p - 1))}
            >
              ‹
            </button>
            <button
              className="pagerBtn"
              type="button"
              aria-label="Next page"
              disabled={!itemsHasNext || isLoading}
              onClick={() => setItemsPage((p) => p + 1)}
            >
              ›
            </button>
          </div>

          <div className="pagerMeta">
            <span>Page:</span>
            <input
              className="pageInput"
              type="text"
              value={itemsPageInput}
              onChange={(e) => setItemsPageInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                const next = toPositiveInt(itemsPageInput, itemsPage);
                const clamped = itemsTotalPages ? Math.min(next, itemsTotalPages) : next;
                setItemsPage(clamped);
              }}
              onBlur={() => {
                const next = toPositiveInt(itemsPageInput, itemsPage);
                const clamped = itemsTotalPages ? Math.min(next, itemsTotalPages) : next;
                setItemsPageInput(String(clamped));
                setItemsPage(clamped);
              }}
              aria-label="Page number"
            />
            <span>of {itemsTotalPages ?? "—"}</span>
          </div>

          <div className="pagerMeta">
            <span>Items per page:</span>
            <select
              className="select selectSmall"
              value={String(itemsLimit)}
              onChange={(e) => {
                const nextLimit = toPositiveInt(e.target.value, itemsLimit);
                setItemsLimit(nextLimit);
                setItemsPageInput("1");
                setItemsPage(1);
              }}
              aria-label="Items per page"
            >
              <option value="50">50</option>
              <option value="100">100</option>
              <option value="200">200</option>
            </select>
          </div>
        </div>
      </div>

      {cartOpen ? (
        <div
          className="posCartOverlay"
          role="dialog"
          aria-modal="true"
          aria-label="Ticket"
        >
          <div className="posCartPanel">
            <div className="posCartHeader">
              <div className="posCartTitle">Ticket</div>
              <button
                type="button"
                className="btn btnGhost btnSmall"
                onClick={() => setCartOpen(false)}
              >
                Close
              </button>
            </div>

            <div className="posCartBody">
              <div className="posCartCustomerRow">
                <div className="posCartCustomerLabel">Customer</div>
                <button
                  type="button"
                  className="posCartCustomerValue"
                  onClick={() => {
                    setCartOpen(false);
                    setCustomerPickerOpen(true);
                    setCustomerSearch("");
                  }}
                >
                  {selectedCustomer?.name ||
                    selectedCustomer?.email ||
                    "Walk-in"}
                </button>
              </div>
              <div className="posCartDiscountRow">
                <div className="posCartCustomerLabel">Discount</div>
                <select
                  className="select posCartDiscountSelect"
                  value={selectedDiscountId}
                  onChange={(e) => setSelectedDiscountId(e.target.value)}
                  aria-label="Discount"
                >
                  <option value="">
                    {isDiscountsLoading ? "Loading..." : "No discount"}
                  </option>
                  {discounts.map((d) => {
                    const valueLabel =
                      d.type === "amount"
                        ? formatMoney(d.value)
                        : d.value == null
                          ? "—"
                          : `${d.value}%`;
                    return (
                      <option key={d.id} value={d.id}>
                        {d.name} ({valueLabel})
                      </option>
                    );
                  })}
                </select>
              </div>
              {discountsError ? (
                <div className="authError posError">{discountsError}</div>
              ) : null}
              {cartCount <= 0 ? (
                <div className="posEmpty">
                  No items yet. Tap an item to add.
                </div>
              ) : (
                Object.values(cartById).map((line) => (
                  <div key={line.id} className="posCartLine">
                    <div className="posCartLineMain">
                      <div className="posCartLineName">{line.name}</div>
                      <div className="posCartLineMeta">
                        {formatMoney(line.price)} × {line.qty}
                      </div>
                    </div>

                    <div className="posCartLineActions" aria-label="Quantity">
                      <button
                        className="posQtyBtn"
                        type="button"
                        onClick={() => setCartQty(line.id, (line.qty || 0) - 1)}
                        aria-label={`Decrease ${line.name}`}
                      >
                        −
                      </button>
                      <div className="posQtyValue" aria-label="Quantity value">
                        {line.qty}
                      </div>
                      <button
                        className="posQtyBtn"
                        type="button"
                        onClick={() => setCartQty(line.id, (line.qty || 0) + 1)}
                        aria-label={`Increase ${line.name}`}
                      >
                        +
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="posCartFooter">
              <div className="posCartSummary" aria-label="Summary">
                <div className="posCartSummaryRow">
                  <span>Subtotal</span>
                  <span className="posCartTotalValue">
                    {formatMoney(cartSubtotal)}
                  </span>
                </div>
                <div className="posCartSummaryRow">
                  <span>Discounts</span>
                  <span className="posCartDiscountValue">
                    -{formatMoney(discountAmount)}
                  </span>
                </div>
                <div className="posCartTotal">
                  <span>Total</span>
                  <span className="posCartTotalValue">
                    {formatMoney(cartTotal)}
                  </span>
                </div>
              </div>
              <button
                type="button"
                className="btn btnPrimary posCartChargeBtn"
                onClick={openCheckout}
                disabled={cartCount <= 0}
              >
                Charge
              </button>
            </div>
          </div>
          <button
            type="button"
            className="posCartBackdrop"
            aria-label="Close ticket"
            onClick={() => setCartOpen(false)}
          />
        </div>
      ) : null}

      {customerPickerOpen ? (
        <div
          className="posCartOverlay"
          role="dialog"
          aria-modal="true"
          aria-label="Customers"
        >
          <div className="posCartPanel">
            <div className="posCartHeader">
              <div className="posCartTitle">Customers</div>
              <button
                type="button"
                className="btn btnGhost btnSmall"
                onClick={() => setCustomerPickerOpen(false)}
              >
                Close
              </button>
            </div>

            <div className="posPickerBody">
              {customersError ? (
                <div className="authError posError">{customersError}</div>
              ) : null}
              <input
                className="textInput posPickerSearch"
                type="search"
                placeholder="Search customers"
                value={customerSearch}
                onChange={(e) => setCustomerSearch(e.target.value)}
                autoFocus
              />

              <div className="posPickerList" role="list">
                {filteredCustomers.length === 0 ? (
                  <div className="posEmpty">
                    {isCustomersLoading ? "Loading…" : "No customers found."}
                  </div>
                ) : (
                  filteredCustomers.map((c) => {
                    const isActive = selectedCustomer?.id === c.id;
                    return (
                      <button
                        key={c.id}
                        type="button"
                        className={`posPickerRow ${isActive ? "posPickerRowActive" : ""}`}
                        onClick={() => {
                          setSelectedCustomer(c);
                          setCustomerPickerOpen(false);
                        }}
                        aria-label={`Select customer ${c.name || c.email || c.id}`}
                      >
                        <span className="posPickerMain">
                          <span className="posPickerName">{c.name || "—"}</span>
                          <span className="posPickerSub">{c.email || "—"}</span>
                        </span>
                        {isActive ? (
                          <span className="posPickerCheck">✓</span>
                        ) : null}
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </div>

          <button
            type="button"
            className="posCartBackdrop"
            aria-label="Close customers"
            onClick={() => setCustomerPickerOpen(false)}
          />
        </div>
      ) : null}
    </div>
  );
}
