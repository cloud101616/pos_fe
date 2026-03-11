import { useEffect, useRef, useState } from "react";
import "./App.css";

import ItemListPage from "./pages/ItemListPage.jsx";
import CreateItemPage from "./pages/CreateItemPage.jsx";
import LoginPage from "./pages/LoginPage.jsx";
import LogoutPage from "./pages/LogoutPage.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";
import UsersPage from "./pages/UsersPage.jsx";
import StoresPage from "./pages/StoresPage.jsx";
import CategoriesPage from "./pages/CategoriesPage.jsx";
import DiscountsPage from "./pages/DiscountsPage.jsx";
import CashierPosPage from "./pages/CashierPosPage.jsx";
import CustomersPage from "./pages/CustomersPage.jsx";
import SalesSummaryPage from "./pages/SalesSummaryPage.jsx";
import SalesByItemPage from "./pages/SalesByItemPage.jsx";
import SalesByCategoryPage from "./pages/SalesByCategoryPage.jsx";
import SalesByEmployeePage from "./pages/SalesByEmployeePage.jsx";
import SalesByPaymentTypePage from "./pages/SalesByPaymentTypePage.jsx";
import ReceiptsReportPage from "./pages/ReceiptsReportPage.jsx";
import EndOfDayCashPage from "./pages/EndOfDayCashPage.jsx";
import MonthlySalesPage from "./pages/MonthlySalesPage.jsx";
import {
  getActorHeaders,
  getAuthUserRole,
  getFetchCredentials,
  resolveStoreId,
} from "./utils/common.js";
import {
  ChevronIcon,
  HelpIcon,
  ItemsIcon,
  MenuIcon,
  MoonIcon,
  SearchIcon,
  ReportsIcon,
  SettingsIcon,
  SunIcon,
  UsersIcon,
  StoreIcon,
  PosIcon,
} from "./icons/index.jsx";

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

function toUiItemStock(apiItem) {
  if (!apiItem || typeof apiItem !== "object") return null;
  const id =
    apiItem.id ??
    apiItem._id ??
    apiItem.itemId ??
    apiItem.uuid ??
    (apiItem.name ? `name:${apiItem.name}` : null);
  if (!id) return null;

  const name = String(apiItem.name ?? "").trim();
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

  return {
    id: String(id),
    name,
    trackStock,
    inStock: Number.isFinite(inStock) ? inStock : null,
  };
}

function App() {
  const apiBaseUrl = (() => {
    const raw = String(
      import.meta.env?.VITE_API_BASE_URL || "http://127.0.0.1:3000",
    ).trim();

    const withoutTrailing = raw.replace(/\/$/, "");
    if (/^https?:\/\//i.test(withoutTrailing)) return withoutTrailing;
    if (/^localhost(:\d+)?$/i.test(withoutTrailing)) return `http://${withoutTrailing}`;
    if (/^[a-z0-9.-]+\.[a-z]{2,}(:\d+)?$/i.test(withoutTrailing))
      return `https://${withoutTrailing}`;

    return withoutTrailing;
  })();

  const getInitialTheme = () => {
    const saved = window.localStorage.getItem("theme");
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  };

  const [theme, setTheme] = useState(() => {
    if (typeof window === "undefined") return "light";
    return getInitialTheme();
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("theme", theme);
  }, [theme]);

  const [authUser, setAuthUser] = useState(() => {
    if (typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem("authUser");
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    if (authUser) {
      window.localStorage.setItem("authUser", JSON.stringify(authUser));
    } else {
      window.localStorage.removeItem("authUser");
    }
  }, [authUser]);

  const [authToken, setAuthToken] = useState(() => {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem("authToken");
  });

  useEffect(() => {
    if (authToken) {
      window.localStorage.setItem("authToken", authToken);
    } else {
      window.localStorage.removeItem("authToken");
    }
  }, [authToken]);

  const isAuthed = Boolean(authToken || authUser);
  const authRole = getAuthUserRole(authUser);
  const isCashier = authRole === "cashier";

  function getDefaultPageForRole(role) {
    if (role === "cashier") return "pos";
    if (role === "admin") return "reports.salesSummary";
    return "items.itemList";
  }

  const [toasts, setToasts] = useState([]);
  const toastTimersRef = useRef(new Map());

  function pushToast({ title, message, variant = "info", ttlMs = 60000 }) {
    const id = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    setToasts((prev) => [...prev, { id, title, message, variant }]);

    const timer = setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      toastTimersRef.current.delete(id);
    }, ttlMs);
    toastTimersRef.current.set(id, timer);
  }

  function dismissToast(id) {
    const timer = toastTimersRef.current.get(id);
    if (timer) clearTimeout(timer);
    toastTimersRef.current.delete(id);
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  useEffect(() => {
    const timers = toastTimersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const lowStockToastInFlightRef = useRef(false);
  const lowStockToastCheckedKeyRef = useRef("");

  useEffect(() => {
    if (isAuthed) return;
    lowStockToastInFlightRef.current = false;
    lowStockToastCheckedKeyRef.current = "";
  }, [isAuthed]);

  async function checkLowStockAndToast({ user, token }) {
    if (!token) return;
    if (lowStockToastInFlightRef.current) return;

    const userId =
      user?.id ?? user?._id ?? user?.userId ?? user?.uuid ?? user?.email ?? "";
    const storeId = resolveStoreId(user);
    const checkedKey = `${String(userId)}|${String(storeId)}|${String(token)}`;
    if (lowStockToastCheckedKeyRef.current === checkedKey) return;

    try {
      lowStockToastInFlightRef.current = true;
      const qs = new URLSearchParams();
      qs.set("limit", "200");
      if (storeId) qs.set("storeId", storeId);

      const response = await fetch(`${apiBaseUrl}/items?${qs.toString()}`, {
        method: "GET",
        credentials: getFetchCredentials(),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          ...getActorHeaders(user),
        },
      });

      const payload = await readJsonSafely(response);
      if (!response.ok) return;
      lowStockToastCheckedKeyRef.current = checkedKey;
      const items = extractItemsList(payload)
        .map(toUiItemStock)
        .filter(Boolean);
      const low = items
        .filter(
          (i) =>
            i.trackStock && typeof i.inStock === "number" && i.inStock < 10,
        )
        .sort((a, b) => (a.inStock ?? 0) - (b.inStock ?? 0));

      if (low.length === 0) return;
      const preview = low
        .slice(0, 3)
        .map((i) => `${i.name || i.id} (${i.inStock})`)
        .join(", ");
      const suffix = low.length > 3 ? ` +${low.length - 3} more` : "";
      pushToast({
        title: "Low stock alert",
        message: `${low.length} item(s) are below 10 in stock. ${preview}${suffix}`,
        variant: "warning",
        ttlMs: 60000,
      });
    } finally {
      lowStockToastInFlightRef.current = false;
    }
  }

  async function loginWithApi({ email, password }) {
    let response;
    try {
      console.log("apiBaseUrl->", apiBaseUrl);
      response = await fetch(`${apiBaseUrl}/users/login`, {
        method: "POST",
        credentials: getFetchCredentials(),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to fetch.";
      return {
        ok: false,
        error:
          `Cannot reach login server. (${message}) ` +
          "Check API server, URL, and CORS.",
      };
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const apiMessage =
        (payload && (payload.message || payload.error)) ||
        `Login failed (HTTP ${response.status}).`;
      return { ok: false, error: String(apiMessage) };
    }

    const token =
      payload?.token ||
      payload?.accessToken ||
      payload?.access_token ||
      payload?.data?.token ||
      payload?.data?.accessToken ||
      payload?.data?.access_token ||
      null;
    const user =
      payload?.user || payload?.data?.user || payload?.data || payload || null;

    const role = getAuthUserRole(user);

    setAuthToken(token || null);
    setAuthUser(user);
    return { ok: true, user, role, token };
  }

  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => isCashier);
  const [activePage, setActivePage] = useState(() => {
    if (!isAuthed) return "login";
    return getDefaultPageForRole(authRole);
  });

  useEffect(() => {
    if (
      activePage !== "settings" &&
      activePage !== "reports.discounts" &&
      activePage !== "reports.taxes"
    )
      return;
    setActivePage(isCashier ? "pos" : "items.itemList");
  }, [activePage, isCashier]);

  useEffect(() => {
    if (!isAuthed || !isCashier) return;
    if (activePage === "pos" || activePage === "customers" || activePage === "logout")
      return;
    if (activePage === "cashier.mySales") return;
    if (activePage === "cashier.endOfDayCash") return;
    if (activePage === "items.itemList") return;

    if (String(activePage || "").startsWith("items.")) {
      setEditingItemId(null);
      setActivePage("items.itemList");
      return;
    }

    setEditingItemId(null);
    setActivePage("pos");
  }, [activePage, isAuthed, isCashier]);
  const [editingItemId, setEditingItemId] = useState(null);
  const [expandedSections, setExpandedSections] = useState({
    reports: true,
    items: false,
  });
  const [topbarSearch, setTopbarSearch] = useState("");

  const sidebarItems = isCashier
    ? [
        { type: "link", id: "pos", label: "Sales", Icon: PosIcon },
        { type: "link", id: "cashier.mySales", label: "My sales", Icon: ReportsIcon },
        {
          type: "link",
          id: "cashier.endOfDayCash",
          label: "End of Day Cash",
          Icon: ReportsIcon,
        },
        { type: "link", id: "items.itemList", label: "Items", Icon: ItemsIcon },
        { type: "link", id: "customers", label: "Customers", Icon: UsersIcon },
        { type: "link", id: "settings", label: "Settings", Icon: SettingsIcon, hidden: true },
        { type: "link", id: "logout", label: "Logout", Icon: SettingsIcon },
      ]
    : [
        {
          type: "section",
          id: "reports",
          label: "Reports",
          Icon: ReportsIcon,
          children: [
            { id: "reports.salesSummary", label: "Sales summary" },
            { id: "reports.salesByItem", label: "Sales by item" },
            { id: "reports.salesByCategory", label: "Sales by category" },
            { id: "reports.salesByEmployee", label: "Sales by employee" },
            {
              id: "reports.salesByPaymentType",
              label: "Sales by payment type",
            },
            { id: "reports.receipts", label: "Receipts" },
            { id: "reports.endOfDayCash", label: "End of Day Cash" },
            { id: "reports.monthlySales", label: "Monthly sales" },
            // { id: "reports.salesByModifier", label: "Sales by modifier" },
            { id: "reports.discounts", label: "Discounts", hidden: true },
            { id: "reports.taxes", label: "Taxes", hidden: true },
          ],
        },
        {
          type: "section",
          id: "items",
          label: "Items",
          Icon: ItemsIcon,
          children: [
            { id: "items.itemList", label: "Item list" },
            { id: "items.createItem", label: "Create item", hidden: true },
            { id: "items.categories", label: "Categories" },
            { id: "items.discounts", label: "Discounts" },
          ],
        },
        { type: "link", id: "users", label: "Users", Icon: UsersIcon },
        { type: "link", id: "stores", label: "Stores", Icon: StoreIcon },
        { type: "link", id: "customers", label: "Customers", Icon: UsersIcon },
        { type: "link", id: "settings", label: "Settings", Icon: SettingsIcon, hidden: true },
        { type: "link", id: "logout", label: "Logout", Icon: SettingsIcon },
        // { type: "link", id: "help", label: "Help", Icon: HelpIcon },
      ];

  const activeLabel = (() => {
    if (!isAuthed) return "Login";
    for (const item of sidebarItems) {
      if (item.type === "link" && item.id === activePage) return item.label;
      if (item.type === "section") {
        for (const child of item.children) {
          if (child.id === activePage) return child.label;
        }
      }
    }
    return "App";
  })();

  const content = (() => {
    if (!isAuthed) {
      return (
        <LoginPage
          onLogin={async ({ email, password }) => {
            const result = await loginWithApi({ email, password });
            if (result.ok) {
              setExpandedSections((s) => ({
                ...s,
                reports: result.role === "admin",
                items: result.role !== "cashier" && result.role !== "admin",
              }));
              if (result.role === "cashier") setIsSidebarCollapsed(true);
              setActivePage(getDefaultPageForRole(result.role));
              void checkLowStockAndToast({
                user: result.user,
                token: result.token,
              });
            }
            return result;
          }}
        />
      );
    }

    if (activePage === "logout")
      return (
        <LogoutPage
          onCancel={() => setActivePage(isCashier ? "pos" : "items.itemList")}
          onConfirm={() => {
            setAuthUser(null);
            setAuthToken(null);
            setIsSidebarCollapsed(false);
            setTopbarSearch("");
            setActivePage("login");
          }}
        />
      );
    if (activePage === "pos")
      return (
        <CashierPosPage
          apiBaseUrl={apiBaseUrl}
          authToken={authToken}
          authUser={authUser}
        />
      );
    if (activePage === "cashier.mySales")
      return (
        <ReceiptsReportPage
          apiBaseUrl={apiBaseUrl}
          authToken={authToken}
          authUser={authUser}
          lockedEmployeeId={
            authUser?.id ?? authUser?._id ?? authUser?.userId ?? authUser?.uuid ?? ""
          }
          hideEmployeeFilter
          hideStoreFilter
          hideSummary
          replaceEmployeeColumnWithItems
        />
      );
    if (activePage === "cashier.endOfDayCash")
      return (
        <EndOfDayCashPage
          apiBaseUrl={apiBaseUrl}
          authToken={authToken}
          authUser={authUser}
          lockedEmployeeId={
            authUser?.id ?? authUser?._id ?? authUser?.userId ?? authUser?.uuid ?? ""
          }
          hideStoreFilter
        />
      );
    if (activePage === "settings") return <SettingsPage />;
    if (activePage === "customers")
      return (
        <CustomersPage
          apiBaseUrl={apiBaseUrl}
          authToken={authToken}
          authUser={authUser}
          searchQuery={topbarSearch}
        />
      );
    if (activePage === "users")
      return (
        <UsersPage
          apiBaseUrl={apiBaseUrl}
          authToken={authToken}
          authUser={authUser}
          searchQuery={topbarSearch}
          currentRole={authRole}
        />
      );
    if (activePage === "stores")
      return (
        <StoresPage
          apiBaseUrl={apiBaseUrl}
          authToken={authToken}
          authUser={authUser}
          searchQuery={topbarSearch}
        />
      );
    if (activePage === "items.itemList")
      return (
        <ItemListPage
          apiBaseUrl={apiBaseUrl}
          authToken={authToken}
          authUser={authUser}
          readOnly={isCashier}
          compact={isCashier}
          storeIdFilter={isCashier ? resolveStoreId(authUser) : ""}
          onAddItem={
            isCashier
              ? undefined
              : () => {
                  setEditingItemId(null);
                  setExpandedSections((s) => ({ ...s, items: true }));
                  setActivePage("items.createItem");
                }
          }
          onEditItem={
            isCashier
              ? undefined
              : (itemId) => {
                  setEditingItemId(itemId);
                  setExpandedSections((s) => ({ ...s, items: true }));
                  setActivePage("items.createItem");
                }
          }
          searchQuery={topbarSearch}
        />
      );
    if (activePage === "items.createItem")
      return (
        <CreateItemPage
          key={editingItemId || "new"}
          apiBaseUrl={apiBaseUrl}
          authToken={authToken}
          authUser={authUser}
          itemId={editingItemId}
          onCancel={() => {
            setEditingItemId(null);
            setExpandedSections((s) => ({ ...s, items: true }));
            setActivePage("items.itemList");
          }}
          onSaved={() => {
            setEditingItemId(null);
            setExpandedSections((s) => ({ ...s, items: true }));
            setActivePage("items.itemList");
          }}
        />
      );
    if (activePage === "items.categories")
      return (
        <CategoriesPage
          apiBaseUrl={apiBaseUrl}
          authToken={authToken}
          authUser={authUser}
          searchQuery={topbarSearch}
        />
      );
    if (activePage === "items.discounts")
      return (
        <DiscountsPage
          apiBaseUrl={apiBaseUrl}
          authToken={authToken}
          authUser={authUser}
          searchQuery={topbarSearch}
        />
      );
    if (activePage === "items.modifiers")
      return (
        <DiscountsPage
          apiBaseUrl={apiBaseUrl}
          authToken={authToken}
          authUser={authUser}
          searchQuery={topbarSearch}
        />
      );
    if (activePage === "reports.salesSummary")
      return (
        <SalesSummaryPage
          apiBaseUrl={apiBaseUrl}
          authToken={authToken}
          authUser={authUser}
        />
      );
    if (activePage === "reports.salesByItem")
      return (
        <SalesByItemPage
          apiBaseUrl={apiBaseUrl}
          authToken={authToken}
          authUser={authUser}
        />
      );
    if (activePage === "reports.salesByCategory")
      return (
        <SalesByCategoryPage
          apiBaseUrl={apiBaseUrl}
          authToken={authToken}
          authUser={authUser}
        />
      );
    if (activePage === "reports.salesByEmployee")
      return (
        <SalesByEmployeePage
          apiBaseUrl={apiBaseUrl}
          authToken={authToken}
          authUser={authUser}
        />
      );
    if (activePage === "reports.salesByPaymentType")
      return (
        <SalesByPaymentTypePage
          apiBaseUrl={apiBaseUrl}
          authToken={authToken}
          authUser={authUser}
        />
      );
    if (activePage === "reports.receipts")
      return (
        <ReceiptsReportPage
          apiBaseUrl={apiBaseUrl}
          authToken={authToken}
          authUser={authUser}
        />
      );
    if (activePage === "reports.endOfDayCash")
      return (
        <EndOfDayCashPage
          apiBaseUrl={apiBaseUrl}
          authToken={authToken}
          authUser={authUser}
        />
      );
    if (activePage === "reports.monthlySales")
      return (
        <MonthlySalesPage
          apiBaseUrl={apiBaseUrl}
          authToken={authToken}
          authUser={authUser}
        />
      );
    return null;
  })();

  return (
    <div className="appShell">
      {toasts.length ? (
        <div className="toastStack" aria-label="Notifications">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`toast${t.variant === "warning" ? " toastWarning" : ""}`}
              role="status"
              aria-live="polite"
            >
              <div className="toastBody">
                <div className="toastTitle">{t.title}</div>
                <div className="toastMsg">{t.message}</div>
              </div>
              <button
                type="button"
                className="toastClose"
                aria-label="Dismiss notification"
                onClick={() => dismissToast(t.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <header className="topbar">
        {isAuthed ? (
          <button
            className="menuButton"
            type="button"
            aria-label={
              isSidebarCollapsed ? "Expand navigation" : "Collapse navigation"
            }
            aria-expanded={!isSidebarCollapsed}
            aria-controls="sidebar"
            onClick={() => setIsSidebarCollapsed((v) => !v)}
          >
            <MenuIcon className="topbarIcon" />
          </button>
        ) : (
          <div className="menuButton" aria-hidden="true" />
        )}
        <div className="topbarTitle">{activeLabel}</div>

        {isAuthed ? (
          <div className="topbarSearch" role="search" aria-label="Search">
            <SearchIcon className="topbarSearchIcon" />
            <input
              className="topbarSearchInput"
              type="search"
              placeholder="Search"
              value={topbarSearch}
              onChange={(e) => setTopbarSearch(e.target.value)}
            />
          </div>
        ) : null}

        <div className="topbarSpacer" />
        <button
          className="iconButton"
          type="button"
          aria-label={
            theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
          }
          onClick={() => {
            setTheme((t) => (t === "dark" ? "light" : "dark"));
          }}
        >
          {theme === "dark" ? (
            <SunIcon className="topbarIcon" />
          ) : (
            <MoonIcon className="topbarIcon" />
          )}
        </button>
      </header>

      <div
        className={`shellBody ${isSidebarCollapsed ? "shellBodyCollapsed" : ""}`}
      >
        {isAuthed ? (
          <aside className="sidebar" id="sidebar">
            <nav className="nav" aria-label="Primary">
              {sidebarItems.map((item) => {
                const Icon = item.Icon;

                if (item.type === "link") {
                  if (item.hidden) return null;
                  const isActive = activePage === item.id;

                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`navItem ${isActive ? "navItemActive" : ""}`}
                      onClick={() => setActivePage(item.id)}
                      aria-current={isActive ? "page" : undefined}
                      title={item.label}
                    >
                      <span className="navItemLeft">
                        <Icon className="navIcon" />
                        <span className="navLabel">{item.label}</span>
                      </span>
                    </button>
                  );
                }

                const isExpanded = Boolean(expandedSections[item.id]);

                return (
                  <div key={item.id} className="navSection">
                    <button
                      type="button"
                      className="navItem navItemSection"
                      onClick={() => {
                        if (isSidebarCollapsed) {
                          setIsSidebarCollapsed(false);
                          setExpandedSections((s) => ({
                            ...s,
                            [item.id]: true,
                          }));
                          return;
                        }

                        setExpandedSections((s) => ({
                          ...s,
                          [item.id]: !s[item.id],
                        }));
                      }}
                      aria-expanded={isExpanded}
                      title={item.label}
                    >
                      <span className="navItemLeft">
                        <Icon className="navIcon" />
                        <span className="navLabel">{item.label}</span>
                      </span>
                      <ChevronIcon
                        className={`chevron ${isExpanded ? "chevronOpen" : ""}`}
                      />
                    </button>

                    {!isSidebarCollapsed && isExpanded ? (
                      <div
                        className="subNav"
                        role="group"
                        aria-label={item.label}
                      >
                        {item.children
                          .filter((child) => !child.hidden)
                          .map((child) => {
                            const isActive = activePage === child.id;
                            return (
                              <button
                                key={child.id}
                                type="button"
                                className={`subNavItem ${isActive ? "subNavItemActive" : ""}`}
                                onClick={() => {
                                  if (child.id === "items.createItem") {
                                    setEditingItemId(null);
                                  }
                                  setExpandedSections((s) => ({
                                    ...s,
                                    [item.id]: true,
                                  }));
                                  setActivePage(child.id);
                                }}
                                aria-current={isActive ? "page" : undefined}
                              >
                                {child.label}
                              </button>
                            );
                          })}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </nav>
          </aside>
        ) : null}

        <main className="content" aria-label="Page content">
          {content}
        </main>
      </div>
    </div>
  );
}

export default App;
