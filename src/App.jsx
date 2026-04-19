import { useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import * as pdfjsLib from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

const ADMIN_CREDENTIALS = {
  username: "admin",
  password: "admin1234",
};

function getTodayString() {
  return new Date().toISOString().split("T")[0];
}

function getFirstDayOfMonthString() {
  const today = new Date();
  return new Date(today.getFullYear(), today.getMonth(), 1)
    .toISOString()
    .split("T")[0];
}

function formatDisplayDate(value) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

const defaultPointHistory = [
  {
    title: "Belanja Harian",
    date: "18 Apr 2026",
    points: "+120 Poin",
  },
];

const defaultSalesItems = [
  {
    name: "Air Mineral 600ml",
    qty: 2,
    price: 3500,
  },
  {
    name: "Roti Coklat",
    qty: 1,
    price: 8500,
  },
  {
    name: "Susu UHT",
    qty: 1,
    price: 7800,
  },
];

const defaultConfig = {
  STORE_NAME: "AIRFORCE MART SDM",
  SOURCE_SHEET_NAME: "UMUM",
  POINT_DIVISOR: 10,
  POINT_RULE: "1 poin per kelipatan rupiah pada POINT_DIVISOR",
  CURRENCY_LOCALE: "id-ID",
  DATE_FROM: getFirstDayOfMonthString(),
  DATE_TO: getTodayString(),
};

const ignoredPdfRows = [
  "subtotal",
  "total",
  "grand total",
  "tax",
  "ppn",
  "diskon",
  "discount",
  "cash",
  "debit",
  "kredit",
  "change",
  "kembalian",
  "kasir",
  "cashier",
  "invoice",
  "nomor",
  "tanggal",
  "member",
  "terima kasih",
  "thank you",
];

const excelHeaderAliases = {
  name: [
    "nama",
    "item",
    "produk",
    "barang",
    "description",
    "deskripsi",
    "product",
    "product name",
    "nama barang",
    "nama produk",
  ],
  qty: ["qty", "jumlah", "kuantitas", "quantity", "pcs", "unit"],
  price: [
    "harga",
    "price",
    "harga satuan",
    "unit price",
    "harga/pcs",
    "price per unit",
  ],
  total: ["total", "subtotal", "amount", "jumlah harga", "nilai"],
};

function normalizeKey(value) {
  return String(value ?? "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9 ]/g, "");
}

function parseMoney(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  const digits = String(value ?? "").replace(/[^0-9-]/g, "");
  return digits ? Number(digits) : 0;
}

function parseQty(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const cleaned = String(value ?? "")
    .replace(/[^0-9,.-]/g, "")
    .replace(/\.(?=\d{3}(\D|$))/g, "")
    .replace(",", ".");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function pickValueByAliases(row, aliases) {
  const entries = Object.entries(row || {});
  for (const [key, value] of entries) {
    const normalized = normalizeKey(key);
    if (aliases.includes(normalized) && value !== "" && value != null) {
      return value;
    }
  }
  return "";
}

function normalizeExcelRows(rows) {
  return rows
    .map((row) => {
      const name = pickValueByAliases(row, excelHeaderAliases.name);
      const qtyRaw = pickValueByAliases(row, excelHeaderAliases.qty);
      const priceRaw = pickValueByAliases(row, excelHeaderAliases.price);
      const totalRaw = pickValueByAliases(row, excelHeaderAliases.total);

      const qty = parseQty(qtyRaw) || 1;
      const price = parseMoney(priceRaw);
      const total = parseMoney(totalRaw) || price * qty;

      if (!name || (!price && !total)) return null;

      return {
        name: String(name).trim(),
        qty,
        price: price || Math.round(total / qty),
      };
    })
    .filter(Boolean);
}

function findRowIndex(matrix, matcher) {
  return matrix.findIndex((row) => matcher((row || []).map((cell) => normalizeKey(cell))));
}

function parseStructuredTemplateSheet(matrix) {
  const transactionHeaderIndex = findRowIndex(matrix, (cells) => {
    return (
      cells[0] === "no" &&
      cells[1] === "id member" &&
      cells[2] === "nama member" &&
      cells[3] === "nama produk" &&
      cells[4] === "qty" &&
      cells[5] === "harga katalog hk" &&
      cells[6] === "total hk" &&
      cells[7] === "grand total"
    );
  });

  const configHeaderIndex = findRowIndex(matrix, (cells) => {
    return cells[0] === "key" && cells[1] === "value";
  });

  const config = { ...defaultConfig };
  if (configHeaderIndex >= 0) {
    for (let index = configHeaderIndex + 1; index < matrix.length; index += 1) {
      const row = matrix[index] || [];
      const key = String(row[0] ?? "").trim();
      const value = row[1];
      if (!key) continue;
      config[key] = value;
    }
  }

  if (transactionHeaderIndex < 0) {
    return {
      members: [],
      config,
    };
  }

  const transactionRows = matrix.slice(
    transactionHeaderIndex + 1,
    configHeaderIndex >= 0 ? configHeaderIndex : matrix.length
  );

  const members = [];
  let currentMember = null;

  for (const row of transactionRows) {
    const no = row[0];
    const memberId = row[1];
    const memberName = String(row[2] ?? "").trim();
    const productName = String(row[3] ?? "").trim();
    const qty = parseQty(row[4]);
    const price = parseMoney(row[5]);
    const lineTotal = parseMoney(row[6]);
    const grandTotal = parseMoney(row[7]);

    const startsNewMember =
      String(no ?? "").trim() !== "" ||
      String(memberId ?? "").trim() !== "" ||
      memberName !== "" ||
      grandTotal > 0;

    if (startsNewMember) {
      currentMember = {
        no: String(no ?? "").trim(),
        memberId: String(memberId ?? "").trim(),
        memberName: memberName || "Tanpa Nama Member",
        grandTotal,
        items: [],
      };
      members.push(currentMember);
    }

    if (productName && currentMember) {
      currentMember.items.push({
        name: productName,
        qty: qty || 1,
        price: price || Math.round(lineTotal / (qty || 1)),
        total: lineTotal || (qty || 1) * price,
      });
    }
  }

  const normalizedMembers = members
    .map((member) => ({
      ...member,
      grandTotal:
        member.grandTotal ||
        member.items.reduce((sum, item) => sum + item.qty * item.price, 0),
    }))
    .filter((member) => member.memberId || member.memberName || member.items.length);

  return {
    members: normalizedMembers,
    config: {
      ...config,
      POINT_DIVISOR: parseMoney(config.POINT_DIVISOR) || defaultConfig.POINT_DIVISOR,
      DATE_FROM: String(config.DATE_FROM || defaultConfig.DATE_FROM),
      DATE_TO: String(config.DATE_TO || defaultConfig.DATE_TO),
    },
  };
}

function normalizePdfTextItems(items) {
  return items
    .map((item) => ({
      text: String(item.str || "").trim(),
      x: item.transform?.[4] ?? 0,
      y: Math.round(item.transform?.[5] ?? 0),
    }))
    .filter((item) => item.text);
}

function groupPdfLines(textItems) {
  const sorted = [...textItems].sort((a, b) => {
    if (Math.abs(b.y - a.y) <= 2) return a.x - b.x;
    return b.y - a.y;
  });

  const groups = [];
  for (const item of sorted) {
    const group = groups.find((entry) => Math.abs(entry.y - item.y) <= 2);
    if (group) {
      group.items.push(item);
    } else {
      groups.push({ y: item.y, items: [item] });
    }
  }

  return groups
    .map((group) =>
      group.items
        .sort((a, b) => a.x - b.x)
        .map((item) => item.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter(Boolean);
}

function isIgnoredPdfLine(line) {
  const normalized = normalizeKey(line);
  return ignoredPdfRows.some((keyword) => normalized.includes(keyword));
}

function extractTransactionFromPdfLine(line) {
  const cleaned = line.replace(/rp\.?/gi, "").replace(/\s+/g, " ").trim();
  if (!cleaned || isIgnoredPdfLine(cleaned)) return null;
  if (!/[a-zA-Z]/.test(cleaned) || !/\d/.test(cleaned)) return null;

  const patterns = [
    /^(?<name>.+?)\s+(?<qty>\d+(?:[.,]\d+)?)\s*[xX]\s*(?<price>[\d.,]+)\s+(?<total>[\d.,]+)$/,
    /^(?<name>.+?)\s+(?<qty>\d+(?:[.,]\d+)?)\s+(?<price>[\d.,]+)\s+(?<total>[\d.,]+)$/,
    /^(?<name>.+?)\s+(?<total>[\d.,]+)$/,
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (!match?.groups) continue;

    const name = String(match.groups.name || "")
      .replace(/[-:]+$/g, "")
      .trim();
    const qty = parseQty(match.groups.qty) || 1;
    const total = parseMoney(match.groups.total);
    const price = parseMoney(match.groups.price) || Math.round(total / qty);

    if (!name || !total) continue;

    return {
      name,
      qty,
      price,
    };
  }

  const numberTokens = cleaned.match(/\d[\d.,]*/g) || [];
  if (numberTokens.length >= 2) {
    const total = parseMoney(numberTokens[numberTokens.length - 1]);
    const qtyGuess = parseQty(numberTokens[0]) || 1;
    const priceGuess =
      numberTokens.length >= 3
        ? parseMoney(numberTokens[numberTokens.length - 2])
        : Math.round(total / qtyGuess);

    const name = cleaned
      .replace(/\d[\d.,]*/g, " ")
      .replace(/[xX]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (name && total > 0) {
      return {
        name,
        qty: qtyGuess,
        price: priceGuess || Math.round(total / qtyGuess),
      };
    }
  }

  return null;
}

async function extractItemsFromPdf(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  const lines = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const normalizedItems = normalizePdfTextItems(textContent.items || []);
    lines.push(...groupPdfLines(normalizedItems));
  }

  const parsedItems = lines
    .map(extractTransactionFromPdfLine)
    .filter(Boolean)
    .filter((item) => item.price > 0);

  const deduped = parsedItems.filter((item, index, array) => {
    const firstIndex = array.findIndex(
      (candidate) =>
        candidate.name === item.name &&
        candidate.qty === item.qty &&
        candidate.price === item.price
    );
    return firstIndex === index;
  });

  return deduped;
}

function LoginScreen({
  loginMode,
  setLoginMode,
  memberForm,
  setMemberForm,
  adminForm,
  setAdminForm,
  authError,
  onLogin,
}) {
  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-white rounded-[2rem] shadow-2xl overflow-hidden border border-slate-200">
        <div className="bg-gradient-to-br from-red-500 via-rose-500 to-orange-400 text-white p-6">
          <p className="text-xs opacity-80">AIRFORCE MART SDM</p>
          <h1 className="text-3xl font-bold mt-2">Login Aplikasi</h1>
          <p className="text-sm opacity-90 mt-2">
            Member login tanpa password. Admin wajib username dan password.
          </p>
        </div>

        <div className="p-5">
          <div className="grid grid-cols-2 bg-slate-100 rounded-2xl p-1 mb-5">
            <button
              type="button"
              onClick={() => setLoginMode("member")}
              className={`rounded-2xl py-3 text-sm font-semibold transition ${
                loginMode === "member"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500"
              }`}
            >
              Login Member
            </button>
            <button
              type="button"
              onClick={() => setLoginMode("admin")}
              className={`rounded-2xl py-3 text-sm font-semibold transition ${
                loginMode === "admin"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500"
              }`}
            >
              Login Admin
            </button>
          </div>

          {loginMode === "member" ? (
            <form className="space-y-4" onSubmit={(event) => onLogin(event, "member")}>
              <div>
                <label className="block text-sm font-semibold text-slate-800 mb-2">ID Member</label>
                <input
                  value={memberForm.memberId}
                  onChange={(event) =>
                    setMemberForm((prev) => ({ ...prev, memberId: event.target.value }))
                  }
                  placeholder="Contoh: MBR-0001"
                  className="w-full border border-slate-200 rounded-2xl px-4 py-3 text-sm outline-none focus:border-red-400"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-slate-800 mb-2">Nama Member</label>
                <input
                  value={memberForm.memberName}
                  onChange={(event) =>
                    setMemberForm((prev) => ({ ...prev, memberName: event.target.value }))
                  }
                  placeholder="Masukkan nama member"
                  className="w-full border border-slate-200 rounded-2xl px-4 py-3 text-sm outline-none focus:border-red-400"
                />
              </div>
              <button className="w-full bg-slate-900 text-white py-3 rounded-2xl text-sm font-bold">
                Masuk sebagai Member
              </button>
            </form>
          ) : (
            <form className="space-y-4" onSubmit={(event) => onLogin(event, "admin")}>
              <div>
                <label className="block text-sm font-semibold text-slate-800 mb-2">Username Admin</label>
                <input
                  value={adminForm.username}
                  onChange={(event) =>
                    setAdminForm((prev) => ({ ...prev, username: event.target.value }))
                  }
                  placeholder="Masukkan username"
                  className="w-full border border-slate-200 rounded-2xl px-4 py-3 text-sm outline-none focus:border-red-400"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-slate-800 mb-2">Password</label>
                <input
                  type="password"
                  value={adminForm.password}
                  onChange={(event) =>
                    setAdminForm((prev) => ({ ...prev, password: event.target.value }))
                  }
                  placeholder="Masukkan password"
                  className="w-full border border-slate-200 rounded-2xl px-4 py-3 text-sm outline-none focus:border-red-400"
                />
              </div>
              <div className="bg-slate-50 border border-slate-200 rounded-2xl p-3 text-xs text-slate-500">
                Demo admin: username <span className="font-bold">admin</span>, password <span className="font-bold">admin123</span>
              </div>
              <button className="w-full bg-slate-900 text-white py-3 rounded-2xl text-sm font-bold">
                Masuk sebagai Admin
              </button>
            </form>
          )}

          {authError && (
            <div className="mt-4 bg-red-50 text-red-600 border border-red-200 rounded-2xl p-3 text-sm">
              {authError}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function AlpaGiftStyleApp() {
  const [loginMode, setLoginMode] = useState("member");
  const [authUser, setAuthUser] = useState(null);
  const [authError, setAuthError] = useState("");
  const [memberForm, setMemberForm] = useState({
    memberId: "",
    memberName: "",
  });
  const [adminForm, setAdminForm] = useState({
    username: "",
    password: "",
  });
  const [view, setView] = useState("member");
  const [pointHistory] = useState(defaultPointHistory);
  const [fallbackSalesItems, setFallbackSalesItems] = useState(defaultSalesItems);
  const [importedMembers, setImportedMembers] = useState([]);
  const [selectedMemberIndex, setSelectedMemberIndex] = useState(0);
  const [appConfig, setAppConfig] = useState(defaultConfig);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [uploadInfo, setUploadInfo] = useState(null);
  const [dateRange, setDateRange] = useState({
    from: defaultConfig.DATE_FROM,
    to: defaultConfig.DATE_TO,
  });
  const fileInputRef = useRef(null);

  const isAdmin = authUser?.role === "admin";
  const activeMember = importedMembers[selectedMemberIndex] || null;
  const salesItems = activeMember ? activeMember.items : fallbackSalesItems;
  const total = useMemo(() => {
    if (activeMember?.grandTotal) return activeMember.grandTotal;
    return salesItems.reduce((sum, item) => sum + item.qty * item.price, 0);
  }, [activeMember, salesItems]);
  const pointDivisor = parseMoney(appConfig.POINT_DIVISOR) || defaultConfig.POINT_DIVISOR;
  const displayDateFrom = dateRange.from || appConfig.DATE_FROM || defaultConfig.DATE_FROM;
  const displayDateTo = dateRange.to || appConfig.DATE_TO || defaultConfig.DATE_TO;
  const earnedPoints = Math.floor(total / pointDivisor);
  const activePointKey =
    activeMember?.memberId || activeMember?.memberName || "default-member";
  const [adminEditedPointsByMember, setAdminEditedPointsByMember] = useState({});
  const [adminPointInputByMember, setAdminPointInputByMember] = useState({});
  const displayedPoints = isAdmin
    ? adminEditedPointsByMember[activePointKey] ?? earnedPoints
    : earnedPoints;
  const activeAdminPointInput = adminPointInputByMember[activePointKey] ?? "";

  const formatRupiah = (value) =>
    new Intl.NumberFormat(appConfig.CURRENCY_LOCALE || "id-ID", {
      style: "currency",
      currency: "IDR",
      maximumFractionDigits: 0,
    }).format(value);

  const handleLogin = (event, role) => {
    event.preventDefault();
    setAuthError("");

    if (role === "member") {
      if (!memberForm.memberId.trim() || !memberForm.memberName.trim()) {
        setAuthError("Member harus mengisi ID member dan nama member.");
        return;
      }

      setAuthUser({
        role: "member",
        memberId: memberForm.memberId.trim(),
        memberName: memberForm.memberName.trim(),
      });
      setView("member");
      return;
    }

    if (
      adminForm.username.trim() !== ADMIN_CREDENTIALS.username ||
      adminForm.password !== ADMIN_CREDENTIALS.password
    ) {
      setAuthError("Username atau password admin tidak sesuai.");
      return;
    }

    setAuthUser({
      role: "admin",
      username: adminForm.username.trim(),
      memberId: "ADMIN",
      memberName: "Administrator",
    });
    setView("sales");
  };

  const handleLogout = () => {
    setAuthUser(null);
    setAuthError("");
    setUploadError("");
    setView("member");
    setImportedMembers([]);
    setSelectedMemberIndex(0);
    setUploadInfo(null);
    setAppConfig(defaultConfig);
    setFallbackSalesItems(defaultSalesItems);
    setDateRange({
      from: defaultConfig.DATE_FROM,
      to: defaultConfig.DATE_TO,
    });
    setAdminEditedPointsByMember({});
    setAdminPointInputByMember({});
    setMemberForm({ memberId: "", memberName: "" });
    setAdminForm({ username: "", password: "" });
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const resetToDefault = () => {
    setFallbackSalesItems(defaultSalesItems);
    setImportedMembers([]);
    setSelectedMemberIndex(0);
    setAppConfig(defaultConfig);
    setDateRange({
      from: defaultConfig.DATE_FROM,
      to: defaultConfig.DATE_TO,
    });
    setAdminEditedPointsByMember({});
    setAdminPointInputByMember({});
    setUploadInfo(null);
    setUploadError("");
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleFileUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!isAdmin) {
      setUploadError("Hanya admin yang dapat upload file transaksi.");
      return;
    }

    setUploading(true);
    setUploadError("");

    try {
      let importedItems = [];
      let importedTemplateMembers = [];
      let importedConfig = defaultConfig;
      const lowerName = file.name.toLowerCase();

      if (lowerName.endsWith(".xlsx") || lowerName.endsWith(".xls") || lowerName.endsWith(".csv")) {
        const buffer = await file.arrayBuffer();
        const workbook = XLSX.read(buffer, { type: "array" });
        const firstSheetName = workbook.SheetNames[0];
        const firstSheet = workbook.Sheets[firstSheetName];

        const matrix = XLSX.utils.sheet_to_json(firstSheet, {
          header: 1,
          defval: "",
          raw: false,
        });
        const structuredResult = parseStructuredTemplateSheet(matrix);

        if (structuredResult.members.length > 0) {
          importedTemplateMembers = structuredResult.members;
          importedConfig = structuredResult.config;
        } else {
          const rows = XLSX.utils.sheet_to_json(firstSheet, { defval: "" });
          importedItems = normalizeExcelRows(rows);
        }
      } else if (lowerName.endsWith(".pdf")) {
        importedItems = await extractItemsFromPdf(file);
      } else {
        throw new Error("Format file belum didukung.");
      }

      if (!importedTemplateMembers.length && !importedItems.length) {
        throw new Error(
          "Data transaksi tidak terbaca. Untuk template Excel, gunakan format: NO, ID MEMBER, NAMA MEMBER, NAMA PRODUK, QTY, HARGA KATALOG (HK), TOTAL HK, GRAND TOTAL."
        );
      }

      if (importedTemplateMembers.length > 0) {
        setImportedMembers(importedTemplateMembers);
        setSelectedMemberIndex(0);
        setAppConfig(importedConfig);
        setDateRange({
          from: importedConfig.DATE_FROM || defaultConfig.DATE_FROM,
          to: importedConfig.DATE_TO || defaultConfig.DATE_TO,
        });
        setFallbackSalesItems(defaultSalesItems);
      } else {
        setImportedMembers([]);
        setFallbackSalesItems(importedItems);
        setAppConfig(defaultConfig);
      }

      setAdminEditedPointsByMember({});
      setAdminPointInputByMember({});

      setUploadInfo({
        fileName: file.name,
        importedAt: new Date().toLocaleString("id-ID"),
        totalItems:
          importedTemplateMembers.length > 0
            ? importedTemplateMembers.reduce((sum, member) => sum + member.items.length, 0)
            : importedItems.length,
        totalMembers: importedTemplateMembers.length,
        sourceType: lowerName.endsWith(".pdf") ? "PDF" : "Excel",
        storeName: importedConfig.STORE_NAME || defaultConfig.STORE_NAME,
        sourceSheetName: importedConfig.SOURCE_SHEET_NAME || "Sheet 1",
        dateFrom: importedConfig.DATE_FROM || dateRange.from || defaultConfig.DATE_FROM,
        dateTo: importedConfig.DATE_TO || dateRange.to || defaultConfig.DATE_TO,
      });
      setView("sales");
    } catch (error) {
      setUploadError(error.message || "Gagal membaca file transaksi.");
    } finally {
      setUploading(false);
    }
  };

  if (!authUser) {
    return (
      <LoginScreen
        loginMode={loginMode}
        setLoginMode={setLoginMode}
        memberForm={memberForm}
        setMemberForm={setMemberForm}
        adminForm={adminForm}
        setAdminForm={setAdminForm}
        authError={authError}
        onLogin={handleLogin}
      />
    );
  }

  const memberDisplayName =
    activeMember?.memberName || authUser?.memberName || "Primkop AU";
  const memberDisplayId = activeMember?.memberId || authUser?.memberId || "-";

  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-white rounded-[2rem] shadow-2xl overflow-hidden border border-slate-200">
        <div className="bg-gradient-to-br from-red-500 via-rose-500 to-orange-400 text-white p-6">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs opacity-80">Kartu Member</p>
              <h1 className="text-2xl font-bold mt-1">{appConfig.STORE_NAME || "Member Loyalty"}</h1>
              <p className="text-sm opacity-90 mt-1">
                Member, poin, dan akses transaksi penjualan
              </p>
            </div>
            <div className="bg-white/20 rounded-2xl px-3 py-2 text-right backdrop-blur-sm">
              <p className="text-[10px] uppercase tracking-wide">Role</p>
              <p className="text-sm font-bold">{isAdmin ? "Admin" : "Member"}</p>
            </div>
          </div>

          <div className="mt-5 bg-white/15 rounded-3xl p-5 backdrop-blur-sm border border-white/20">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-wide opacity-80">Nama Member</p>
                <h2 className="text-xl font-semibold mt-1">{memberDisplayName}</h2>
                <p className="text-xs opacity-80 mt-2">ID Member: {memberDisplayId}</p>
                <p className="text-xs opacity-80 mt-1">
                  Periode: {formatDisplayDate(displayDateFrom)} - {formatDisplayDate(displayDateTo)}
                </p>
              </div>
              <button
                type="button"
                onClick={handleLogout}
                className="bg-white text-red-500 px-4 py-2 rounded-2xl text-sm font-semibold shadow-sm"
              >
                Logout
              </button>
            </div>

            <div className="mt-5 flex items-end justify-between gap-3">
              <div>
                <p className="text-xs opacity-80">{isAdmin ? "Poin Member" : "Estimasi Poin"}</p>
                <p className="text-4xl font-bold leading-none mt-1">{displayedPoints.toLocaleString("id-ID")}</p>
              </div>
              <button
                onClick={() => setView(view === "member" ? "sales" : "member")}
                className="bg-white text-red-500 px-4 py-2 rounded-2xl text-sm font-semibold shadow-sm"
              >
                {view === "member" ? "Buka Transaksi" : "Lihat Member"}
              </button>
            </div>
          </div>
        </div>

        <div className="p-5 space-y-4">
          {isAdmin && (
            <div className="bg-slate-50 rounded-3xl border border-slate-200 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-base font-bold text-slate-800">Upload Data Transaksi</h3>
                  <p className="text-xs text-slate-500 mt-1">
                    Cocok untuk template Excel dengan kolom member dan item seperti sheet referensi.
                  </p>
                </div>
                <div className="bg-white rounded-2xl border border-slate-200 px-3 py-2 text-right">
                  <p className="text-[10px] uppercase tracking-wide text-slate-500">Akses</p>
                  <p className="text-sm font-bold text-slate-800">Diizinkan</p>
                </div>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <div>
                  <label className="block text-sm font-semibold text-slate-800 mb-2">Tanggal Dari</label>
                  <input
                    type="date"
                    value={dateRange.from}
                    onChange={(event) =>
                      setDateRange((prev) => ({ ...prev, from: event.target.value }))
                    }
                    className="w-full bg-white border border-slate-200 rounded-2xl px-4 py-3 text-sm text-slate-800"
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-slate-800 mb-2">Tanggal Sampai</label>
                  <input
                    type="date"
                    value={dateRange.to}
                    onChange={(event) =>
                      setDateRange((prev) => ({ ...prev, to: event.target.value }))
                    }
                    className="w-full bg-white border border-slate-200 rounded-2xl px-4 py-3 text-sm text-slate-800"
                  />
                </div>
              </div>

              <div className="mt-4 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="bg-slate-900 text-white px-4 py-2 rounded-2xl text-sm font-semibold"
                >
                  Pilih File
                </button>
                <p className="text-xs text-slate-500">Hanya admin yang dapat mengimpor transaksi.</p>
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv,.pdf"
                className="hidden"
                onChange={handleFileUpload}
              />

              {uploading && (
                <div className="mt-4 bg-amber-50 text-amber-700 border border-amber-200 rounded-2xl p-3 text-sm">
                  Membaca file transaksi...
                </div>
              )}

              {uploadError && (
                <div className="mt-4 bg-red-50 text-red-600 border border-red-200 rounded-2xl p-3 text-sm">
                  {uploadError}
                </div>
              )}

              {uploadInfo && (
                <div className="mt-4 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-2xl p-4">
                  <p className="text-sm font-bold">Import berhasil</p>
                  <div className="mt-2 text-xs space-y-1">
                    <p>File: {uploadInfo.fileName}</p>
                    <p>Sumber: {uploadInfo.sourceType}</p>
                    <p>Toko: {uploadInfo.storeName}</p>
                    <p>Sheet: {uploadInfo.sourceSheetName}</p>
                    <p>Total member: {uploadInfo.totalMembers}</p>
                    <p>Total baris item: {uploadInfo.totalItems}</p>
                    <p>Periode: {formatDisplayDate(uploadInfo.dateFrom)} - {formatDisplayDate(uploadInfo.dateTo)}</p>
                    <p>Waktu import: {uploadInfo.importedAt}</p>
                  </div>
                  <button
                    type="button"
                    onClick={resetToDefault}
                    className="mt-3 bg-white text-emerald-700 border border-emerald-200 px-3 py-2 rounded-2xl text-xs font-semibold"
                  >
                    Reset ke Data Contoh
                  </button>
                </div>
              )}
            </div>
          )}

          {!isAdmin && (
            <div className="bg-slate-50 rounded-3xl border border-slate-200 p-4">
              <h3 className="text-base font-bold text-slate-800">Periode Transaksi</h3>
              <p className="text-xs text-slate-500 mt-1">
                Atur tanggal dari dan sampai untuk tampilan periode member.
              </p>

              <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <div>
                  <label className="block text-sm font-semibold text-slate-800 mb-2">Tanggal Dari</label>
                  <input
                    type="date"
                    value={dateRange.from}
                    onChange={(event) =>
                      setDateRange((prev) => ({ ...prev, from: event.target.value }))
                    }
                    className="w-full bg-white border border-slate-200 rounded-2xl px-4 py-3 text-sm text-slate-800"
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-slate-800 mb-2">Tanggal Sampai</label>
                  <input
                    type="date"
                    value={dateRange.to}
                    onChange={(event) =>
                      setDateRange((prev) => ({ ...prev, to: event.target.value }))
                    }
                    className="w-full bg-white border border-slate-200 rounded-2xl px-4 py-3 text-sm text-slate-800"
                  />
                </div>
              </div>
            </div>
          )}

          {importedMembers.length > 0 && isAdmin && (
            <div className="bg-slate-50 rounded-3xl border border-slate-200 p-4">
              <label className="block text-sm font-bold text-slate-800">Pilih Member dari File Upload</label>
              <select
                value={selectedMemberIndex}
                onChange={(event) => {
                  setSelectedMemberIndex(Number(event.target.value));
                  setView("sales");
                }}
                className="mt-3 w-full bg-white border border-slate-200 rounded-2xl px-4 py-3 text-sm text-slate-800"
              >
                {importedMembers.map((member, index) => (
                  <option key={`${member.memberId}-${index}`} value={index}>
                    {member.memberName} - {member.memberId || "Tanpa ID"}
                  </option>
                ))}
              </select>
            </div>
          )}

          {view === "member" ? (
            isAdmin ? (
              <div className="bg-slate-50 rounded-3xl border border-slate-200 p-4">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-base font-bold text-slate-800">Edit Poin Member</h3>
                  <span className="text-xs font-medium text-slate-500">Admin Only</span>
                </div>

                <div className="bg-white rounded-2xl border border-slate-200 p-4 space-y-4">
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div className="bg-slate-50 rounded-2xl border border-slate-200 p-3">
                      <p className="text-xs text-slate-500">Poin dari transaksi</p>
                      <p className="text-lg font-bold text-slate-800 mt-1">
                        {earnedPoints.toLocaleString("id-ID")}
                      </p>
                    </div>
                    <div className="bg-slate-50 rounded-2xl border border-slate-200 p-3">
                      <p className="text-xs text-slate-500">Poin aktif ditampilkan</p>
                      <p className="text-lg font-bold text-slate-800 mt-1">
                        {displayedPoints.toLocaleString("id-ID")}
                      </p>
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-semibold text-slate-800 mb-2">
                      Ubah Poin Member
                    </label>
                    <input
                      type="number"
                      min="0"
                      value={activeAdminPointInput}
                      onChange={(event) =>
                        setAdminPointInputByMember((prev) => ({
                          ...prev,
                          [activePointKey]: event.target.value,
                        }))
                      }
                      placeholder="Masukkan jumlah poin baru"
                      className="w-full border border-slate-200 rounded-2xl px-4 py-3 text-sm outline-none focus:border-red-400"
                    />
                  </div>

                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        const parsed = Number(activeAdminPointInput);
                        if (Number.isFinite(parsed) && parsed >= 0) {
                          setAdminEditedPointsByMember((prev) => ({
                            ...prev,
                            [activePointKey]: parsed,
                          }));
                        }
                      }}
                      className="flex-1 bg-slate-900 text-white py-3 rounded-2xl text-sm font-bold"
                    >
                      Simpan Poin
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setAdminEditedPointsByMember((prev) => {
                          const next = { ...prev };
                          delete next[activePointKey];
                          return next;
                        });
                        setAdminPointInputByMember((prev) => {
                          const next = { ...prev };
                          delete next[activePointKey];
                          return next;
                        });
                      }}
                      className="flex-1 bg-white text-slate-800 border border-slate-200 py-3 rounded-2xl text-sm font-bold"
                    >
                      Reset Poin
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="bg-slate-50 rounded-3xl border border-slate-200 p-4">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-base font-bold text-slate-800">Riwayat Poin</h3>
                  <span className="text-xs font-medium text-slate-500">
                    {pointHistory.length} Transaksi
                  </span>
                </div>

                <div className="space-y-3">
                  {pointHistory.map((item) => (
                    <div
                      key={item.title + item.date}
                      className="bg-white rounded-2xl border border-slate-200 p-4 flex items-center justify-between"
                    >
                      <div>
                        <p className="text-sm font-semibold text-slate-800">{item.title}</p>
                        <p className="text-xs text-slate-500 mt-1">{item.date}</p>
                      </div>
                      <p
                        className={`text-sm font-bold ${
                          item.points.startsWith("+") ? "text-emerald-600" : "text-red-500"
                        }`}
                      >
                        {item.points}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )
          ) : (
            <div className="space-y-4">
              <div className="bg-slate-50 rounded-3xl border border-slate-200 p-4">
                <div className="bg-white rounded-2xl border border-slate-200 p-3 mb-4">
                  <p className="text-xs text-slate-500">Periode Transaksi</p>
                  <p className="text-sm font-bold text-slate-800 mt-1">
                    {formatDisplayDate(displayDateFrom)} - {formatDisplayDate(displayDateTo)}
                  </p>
                </div>

                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-base font-bold text-slate-800">Transaksi Penjualan</h3>
                  <span className="text-xs font-medium text-slate-500">
                    {salesItems.length} Item
                  </span>
                </div>

                <div className="space-y-3">
                  {salesItems.map((item) => (
                    <div
                      key={`${item.name}-${item.qty}-${item.price}`}
                      className="bg-white rounded-2xl border border-slate-200 p-4 flex items-center justify-between gap-3"
                    >
                      <div>
                        <p className="text-sm font-semibold text-slate-800">{item.name}</p>
                        <p className="text-xs text-slate-500 mt-1">
                          {item.qty} x {formatRupiah(item.price)}
                        </p>
                      </div>
                      <p className="text-sm font-bold text-slate-800">
                        {formatRupiah(item.qty * item.price)}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-slate-900 text-white rounded-3xl p-5">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-xs text-slate-300">Total Belanja</p>
                    <p className="text-2xl font-bold mt-1">{formatRupiah(total)}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-slate-300">Estimasi Poin</p>
                    <p className="text-xl font-bold mt-1">+{displayedPoints.toLocaleString("id-ID")}</p>
                  </div>
                </div>

                <p className="mt-3 text-xs text-slate-300">
                  {appConfig.POINT_RULE || "Perhitungan poin mengikuti konfigurasi toko."}
                </p>

      
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
