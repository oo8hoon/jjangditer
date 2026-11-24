// 짱디터 (JJangditer) - WebView2 호스트
//
// 윈도우에 기본 포함된 C# 컴파일러(csc.exe)로 빌드된다. 설치해야 하는 개발 도구가 없다.
// 화면(HTML/CSS/JS)은 Electron 판에서 쓰던 것을 그대로 쓰고,
// 창 제어·파일 입출력·트레이·단축키만 여기서 담당한다.
//
//   빌드:  node tools/build.js
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace JJ
{
    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            AppDomain.CurrentDomain.AssemblyResolve += ResolveEmbedded;
            Run(args);
        }

        /// 내장해 둔 WebView2 관리 DLL 을 메모리에서 바로 읽어 쓴다 (파일로 풀지 않음)
        static Assembly ResolveEmbedded(object sender, ResolveEventArgs e)
        {
            var want = new AssemblyName(e.Name).Name + ".dll";
            var asm = Assembly.GetExecutingAssembly();
            foreach (var res in asm.GetManifestResourceNames())
            {
                if (!res.EndsWith(want, StringComparison.OrdinalIgnoreCase)) continue;
                using (var s = asm.GetManifestResourceStream(res))
                using (var ms = new MemoryStream())
                {
                    s.CopyTo(ms);
                    return Assembly.Load(ms.ToArray());
                }
            }
            return null;
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        static void Run(string[] args)
        {
            // 두 번 실행하면 기존 창을 앞으로
            bool first;
            using (var mutex = new Mutex(true, "JJangditer.SingleInstance" +
                (Store.Sandbox.Length > 0 ? "." + Store.Sandbox : ""), out first))
            {
                if (!first) { Native.PokeExisting(); return; }

                // https 로 업데이트를 받으려면 TLS 1.2 이상이 필요하다.
                // (.NET Framework 기본값은 SSL3/TLS1.0 이라 요즘 서버에 연결되지 않는다)
                try
                {
                    ServicePointManager.SecurityProtocol |=
                        SecurityProtocolType.Tls12 | (SecurityProtocolType)12288;   // 12288 = TLS 1.3
                }
                catch
                {
                    try { ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12; }
                    catch { }
                }

                Native.SetDpiAware();
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Assets.Prepare();

                // WebView2 로더가 '작업 폴더\logs' 에 기록을 남긴다.
                // 실행 파일 옆을 더럽히지 않도록 작업 폴더를 데이터 폴더로 옮긴다.
                try { Directory.SetCurrentDirectory(Assets.BinDir); } catch { }
                Application.Run(new AppContext());
            }
        }
    }

    /* =========================== 설정 / 저장 =========================== */

    static class Store
    {
        public static readonly JavaScriptSerializer JS = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };

        /// <summary>
        /// 시험용 딴살림.
        /// JJ_SANDBOX 환경변수를 주면 그 이름으로 설정·작업내용을 따로 쓰고,
        /// 창도 따로 뜬다. 쓰고 있는 짱디터를 닫지 않고 시험하기 위한 것.
        /// </summary>
        public static readonly string Sandbox =
            (Environment.GetEnvironmentVariable("JJ_SANDBOX") ?? "").Trim();

        /// <summary>화면 캐시 폴더 이름 (시험용 딴살림이면 뒤에 이름이 붙는다)</summary>
        public static string LocalName
        {
            get { return "JJangditer" + (Sandbox.Length > 0 ? "-" + Sandbox : ""); }
        }

        public static string DataDir
        {
            get
            {
                var name = "JJangditer" + (Sandbox.Length > 0 ? "-" + Sandbox : "");
                var d = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), name);
                Directory.CreateDirectory(d);
                return d;
            }
        }
        public static string PrefsFile { get { return Path.Combine(DataDir, "prefs.json"); } }
        public static string WorkFile { get { return Path.Combine(DataDir, "workspace.json"); } }

        public static string ReadText(string f)
        {
            try
            {
                if (!File.Exists(f)) return null;
                var t = File.ReadAllText(f, Encoding.UTF8);
                if (t.Length > 0 && t[0] == '\uFEFF') t = t.Substring(1);   // BOM 제거
                return t;
            }
            catch { return null; }
        }

        /// 저장 중 전원이 나가도 기존 파일이 깨지지 않도록 임시 파일에 쓰고 이름을 바꾼다
        public static bool WriteText(string f, string text)
        {
            var tmp = f + ".tmp";
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(f));
                File.WriteAllText(tmp, text, new UTF8Encoding(false));
                if (File.Exists(f)) File.Replace(tmp, f, null);
                else File.Move(tmp, f);
                return true;
            }
            catch
            {
                try { File.Delete(tmp); } catch { }
                return false;
            }
        }

        static bool LooksValid(string json)
        {
            if (string.IsNullOrEmpty(json)) return false;
            try
            {
                var d = JS.Deserialize<Dictionary<string, object>>(json);
                object tabs;
                if (d == null || !d.TryGetValue("tabs", out tabs)) return false;
                var arr = tabs as System.Collections.ArrayList;
                return arr != null && arr.Count > 0;
            }
            catch { return false; }
        }

        /* ---------- 사용자 텍스트 파일 (울트라에디터 등에서 만든 것) ----------
         * 한국어 윈도우에서 만든 txt 는 ANSI(CP949) 인 경우가 많다.
         * 무조건 UTF-8 로 읽으면 한글이 깨지므로 앞부분을 보고 판별한다.
         */
        public const string ENC_UTF8 = "UTF-8";
        public const string ENC_UTF8_BOM = "UTF-8 BOM";
        public const string ENC_UTF16LE = "UTF-16 LE";
        public const string ENC_UTF16BE = "UTF-16 BE";
        public const string ENC_ANSI = "ANSI";

        public static string ReadUserText(string file, out string encName)
        {
            encName = ENC_UTF8;
            var b = File.ReadAllBytes(file);

            if (b.Length >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF)
            {
                encName = ENC_UTF8_BOM;
                return new UTF8Encoding(false).GetString(b, 3, b.Length - 3);
            }
            if (b.Length >= 2 && b[0] == 0xFF && b[1] == 0xFE)
            {
                encName = ENC_UTF16LE;
                return Encoding.Unicode.GetString(b, 2, b.Length - 2);
            }
            if (b.Length >= 2 && b[0] == 0xFE && b[1] == 0xFF)
            {
                encName = ENC_UTF16BE;
                return Encoding.BigEndianUnicode.GetString(b, 2, b.Length - 2);
            }

            // BOM 이 없으면 먼저 UTF-8 로 엄격하게 읽어본다
            try
            {
                var strict = new UTF8Encoding(false, true);
                var t = strict.GetString(b);
                encName = ENC_UTF8;
                return t;
            }
            catch { /* UTF-8 이 아님 */ }

            // UTF-8 이 아니면 시스템 기본 (한국어 윈도우 = CP949)
            encName = ENC_ANSI;
            return Encoding.Default.GetString(b);
        }

        public static Encoding EncOf(string name)
        {
            if (name == ENC_UTF8_BOM) return new UTF8Encoding(true);
            if (name == ENC_UTF16LE) return new UnicodeEncoding(false, true);
            if (name == ENC_UTF16BE) return new UnicodeEncoding(true, true);
            if (name == ENC_ANSI) return Encoding.Default;
            return new UTF8Encoding(false);
        }

        /// 읽을 때의 인코딩 그대로 저장한다 (다른 프로그램에서 안 깨지도록)
        public static bool WriteUserText(string file, string text, string encName)
        {
            var tmp = file + ".tmp";
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(file));
                File.WriteAllText(tmp, text, EncOf(encName));
                if (File.Exists(file)) File.Replace(tmp, file, null);
                else File.Move(tmp, file);
                return true;
            }
            catch
            {
                try { File.Delete(tmp); } catch { }
                return false;
            }
        }

        static DateTime lastBackup = DateTime.MinValue;

        public static string LoadWorkspace()
        {
            var cur = ReadText(WorkFile);
            if (LooksValid(cur)) return cur;

            var bak = ReadText(WorkFile + ".bak");
            if (LooksValid(bak))
            {
                try { if (File.Exists(WorkFile)) File.Move(WorkFile, WorkFile + ".broken"); } catch { }
                WriteText(WorkFile, bak);
                return bak;
            }
            return null;
        }

        public static bool SaveWorkspace(string json)
        {
            if (!LooksValid(json)) return false;          // 빈 내용으로 덮어쓰지 않는다
            if ((DateTime.Now - lastBackup).TotalMinutes > 5)
            {
                var cur = ReadText(WorkFile);
                if (LooksValid(cur)) { try { File.Copy(WorkFile, WorkFile + ".bak", true); } catch { } }
                lastBackup = DateTime.Now;
            }
            return WriteText(WorkFile, json);
        }
    }

    class Prefs
    {
        public int Width = 440;
        public bool Pinned = true;
        public string Theme = "dark";
        public int HideDelay = 500;
        public string DisplayId = null;
        public string DisplayRect = null;   // "x,y,w,h" — 번호가 바뀌어도 찾아내려고
        public string LastDir = null;
        public string UpdateUrl = "";
        public bool AutoUpdate = true;
        public bool LowResource = true;
        public int TriggerZone = 2;        // 띠 범위 0=전체 1=넓게 2=가운데 3=좁게
        public bool Maximized = false;     // 화면 전체로 펼친 상태
        public int RestoreWidth = 0;       // 최대화 전 폭

        public static Prefs Load()
        {
            var p = new Prefs();
            var json = Store.ReadText(Store.PrefsFile);
            if (json == null) return p;
            try
            {
                var d = Store.JS.Deserialize<Dictionary<string, object>>(json);
                p.Width = GetInt(d, "width", p.Width);
                p.Pinned = GetBool(d, "pinned", p.Pinned);
                p.Theme = GetStr(d, "theme", p.Theme);
                p.HideDelay = GetInt(d, "hideDelay", p.HideDelay);
                p.DisplayId = GetStr(d, "displayId", null);
                p.DisplayRect = GetStr(d, "displayRect", null);
                p.LastDir = GetStr(d, "lastDir", null);
                p.UpdateUrl = GetStr(d, "updateUrl", "");
                p.AutoUpdate = GetBool(d, "autoUpdate", p.AutoUpdate);
                p.LowResource = GetBool(d, "lowResource", p.LowResource);
                p.TriggerZone = GetInt(d, "triggerZone", p.TriggerZone);
                p.Maximized = GetBool(d, "maximized", p.Maximized);
                p.RestoreWidth = GetInt(d, "restoreWidth", p.RestoreWidth);
            }
            catch { }
            p.Width = Math.Max(320, Math.Min(1100, p.Width));
            return p;
        }

        public void Save()
        {
            var d = new Dictionary<string, object>
            {
                { "width", Width }, { "pinned", Pinned }, { "theme", Theme },
                { "hideDelay", HideDelay }, { "displayId", DisplayId }, { "displayRect", DisplayRect }, { "lastDir", LastDir },
                { "updateUrl", UpdateUrl }, { "autoUpdate", AutoUpdate }, { "lowResource", LowResource },
                { "maximized", Maximized }, { "restoreWidth", RestoreWidth },
                { "triggerZone", TriggerZone }
            };
            Store.WriteText(Store.PrefsFile, Store.JS.Serialize(d));
        }

        static string GetStr(Dictionary<string, object> d, string k, string def)
        {
            object v; return d.TryGetValue(k, out v) && v != null ? Convert.ToString(v) : def;
        }
        static int GetInt(Dictionary<string, object> d, string k, int def)
        {
            object v;
            if (!d.TryGetValue(k, out v) || v == null) return def;
            try { return Convert.ToInt32(v, CultureInfo.InvariantCulture); } catch { return def; }
        }
        static bool GetBool(Dictionary<string, object> d, string k, bool def)
        {
            object v;
            if (!d.TryGetValue(k, out v) || v == null) return def;
            try { return Convert.ToBoolean(v); } catch { return def; }
        }
    }

    /* =========================== 화면 파일 =========================== */

    static class Assets
    {
        public static string WebDir;
        public static string BinDir;
        /// 사용자가 만든 템플릿(.jjt) 을 두는 곳

        /// exe 안에 넣어둔 화면 파일(zip)을 사용자 폴더에 풀어둔다. 버전이 같으면 건너뛴다.
        public static void Prepare()
        {
            var baseDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), Store.LocalName);
            WebDir = Path.Combine(baseDir, "web");
            BinDir = Path.Combine(baseDir, "bin");
            var stamp = Path.Combine(WebDir, ".stamp");

            try
            {
                var asm = Assembly.GetExecutingAssembly();
                var name = asm.GetManifestResourceNames().FirstOrDefault(n => n.EndsWith("web.zip", StringComparison.OrdinalIgnoreCase));
                if (name == null) throw new Exception("web.zip 리소스를 찾을 수 없습니다");

                // 버전이 아니라 '내용'이 바뀌었을 때 다시 푼다 (같은 버전으로 다시 빌드해도 반영됨)
                byte[] zipBytes;
                using (var s = asm.GetManifestResourceStream(name))
                using (var ms = new MemoryStream()) { s.CopyTo(ms); zipBytes = ms.ToArray(); }
                string hash;
                using (var sha = System.Security.Cryptography.SHA1.Create())
                    hash = BitConverter.ToString(sha.ComputeHash(zipBytes)).Replace("-", "");

                ExtractLoader(hash);
                if (File.Exists(stamp) && File.ReadAllText(stamp) == hash) return;

                if (Directory.Exists(WebDir)) Directory.Delete(WebDir, true);
                Directory.CreateDirectory(WebDir);
                using (var ms = new MemoryStream(zipBytes))
                using (var zip = new ZipArchive(ms, ZipArchiveMode.Read))
                    zip.ExtractToDirectory(WebDir);

                File.WriteAllText(stamp, hash);
            }
            catch (Exception ex)
            {
                MessageBox.Show("화면 파일을 준비하지 못했습니다.\n\n" + ex.Message, "짱디터",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
                Environment.Exit(1);
            }
        }

        /// WebView2 의 네이티브 로더는 메모리에서 못 쓰므로 파일로 한 번 풀어 둔다
        static void ExtractLoader(string tag)
        {
            Directory.CreateDirectory(BinDir);
            var dll = Path.Combine(BinDir, "WebView2Loader.dll");
            var stamp = Path.Combine(BinDir, ".stamp");

            if (!File.Exists(dll) || !File.Exists(stamp) || File.ReadAllText(stamp) != tag)
            {
                var asm = Assembly.GetExecutingAssembly();
                var name = asm.GetManifestResourceNames()
                              .FirstOrDefault(n => n.EndsWith("WebView2Loader.dll", StringComparison.OrdinalIgnoreCase));
                if (name == null) throw new Exception("WebView2Loader.dll 리소스를 찾을 수 없습니다");
                using (var s = asm.GetManifestResourceStream(name))
                using (var f = File.Create(dll))
                    s.CopyTo(f);
                File.WriteAllText(stamp, tag);
            }
            Native.SetDllDirectory(BinDir);
        }
    }

    /* =========================== Win32 =========================== */

    static class Native
    {
        [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint mod, uint vk);
        [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
        [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")] public static extern IntPtr FindWindow(string cls, string title);
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")] public static extern int RegisterWindowMessage(string msg);
        [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool SetDllDirectory(string path);
        [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);

        static int myPid = 0;
        /// 지금 맨 앞에 나와 있는 창이 짱디터(또는 짱디터가 띄운 대화상자)인지
        public static bool ForegroundIsOurs()
        {
            if (myPid == 0) myPid = System.Diagnostics.Process.GetCurrentProcess().Id;
            var h = GetForegroundWindow();
            if (h == IntPtr.Zero) return false;
            int pid;
            GetWindowThreadProcessId(h, out pid);
            return pid == myPid;
        }
        public const int VK_LBUTTON = 0x01;

        public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        public static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
        public const uint SWP_NOMOVE = 0x0002, SWP_NOSIZE = 0x0001, SWP_NOACTIVATE = 0x0010;
        public const uint MOD_ALT = 0x1, MOD_SHIFT = 0x4;
        public const int WM_HOTKEY = 0x0312;

        public static readonly int WM_JJ_SHOW = RegisterWindowMessage("JJangditer.Show");

        public static void SetDpiAware()
        {
            try { SetProcessDpiAwarenessContext(new IntPtr(-4)); }   // PER_MONITOR_AWARE_V2
            catch { }
        }

        /// 이미 떠 있는 짱디터에게 "앞으로 나와라" 고 알린다
        public static void PokeExisting()
        {
            PostMessage(new IntPtr(0xffff), WM_JJ_SHOW, IntPtr.Zero, IntPtr.Zero);  // HWND_BROADCAST
        }

        public static void Topmost(Form f)
        {
            SetWindowPos(f.Handle, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }

        /// 맨 앞 고정을 푼다 (다른 창이 위로 올라올 수 있게)
        public static void NotTopmost(Form f)
        {
            SetWindowPos(f.Handle, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }

        /// 맨 앞 고정 없이, 다른 창들 위로 한 번 올린다 (포커스는 뺏지 않음)
        public static void BringToFront(Form f)
        {
            if (f == null || f.IsDisposed) return;
            SetWindowPos(f.Handle, IntPtr.Zero /*HWND_TOP*/, 0, 0, 0, 0,
                         SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }

        /// 맨 앞에 둘지 말지 한 번에
        public static void SetTopmost(Form f, bool on)
        {
            if (f == null || f.IsDisposed) return;
            if (on) Topmost(f); else NotTopmost(f);
        }
    }


    /* =========================== 찾기 / 바꾸기 창 ===========================
     * 앱 창 밖으로도 끌어낼 수 있도록 진짜 윈도우 창으로 만든다.
     * 모달이 아니라서 열려 있어도 뒤의 글을 그대로 고칠 수 있다.
     */
    class FindForm : Form
    {
        public Action<string> OnAction;          // next / prev / count / rep / repall / change
        public Func<string> AskSelection;        // 글에서 고른 낱말 가져오기

        readonly TextBox tbFind = new TextBox();
        readonly TextBox tbRepl = new TextBox();
        readonly CheckBox cbHl = new CheckBox();
        readonly CheckBox cbCase = new CheckBox();
        readonly CheckBox cbWord = new CheckBox();
        readonly CheckBox cbRe = new CheckBox();
        readonly RadioButton rbUp = new RadioButton();
        readonly RadioButton rbDown = new RadioButton();
        readonly RadioButton rbRow = new RadioButton();
        readonly RadioButton rbTab = new RadioButton();
        readonly Button btTabFind = new Button();
        readonly Button btTabRepl = new Button();
        readonly Button btNext = new Button();
        readonly Button btCount = new Button();
        readonly Button btRep = new Button();
        readonly Button btRepAll = new Button();
        readonly Button btClose = new Button();
        readonly Label lbReplCap = new Label();
        readonly Label lbStat = new Label();

        bool replMode;
        bool quiet;                              // 코드로 값을 바꿀 때 이벤트를 막는다

        static readonly Color BG = ColorTranslator.FromHtml("#1b1e26");
        static readonly Color BG2 = ColorTranslator.FromHtml("#22262f");
        static readonly Color FG = ColorTranslator.FromHtml("#dfe3ea");
        static readonly Color DIM = ColorTranslator.FromHtml("#8c94a3");
        static readonly Color ACC = ColorTranslator.FromHtml("#4da3ff");
        static readonly Color LINE = ColorTranslator.FromHtml("#2e333e");

        public string Query { get { return tbFind.Text; } set { quiet = true; tbFind.Text = value; quiet = false; } }
        public string Replacement { get { return tbRepl.Text; } }
        public bool Hilite { get { return cbHl.Checked; } }
        public bool MatchCase { get { return cbCase.Checked; } }
        public bool WholeWord { get { return cbWord.Checked; } }
        public bool UseRegex { get { return cbRe.Checked; } }
        public bool DirUp { get { return rbUp.Checked; } }
        public bool ScopeTab { get { return rbTab.Checked; } }

        public FindForm()
        {
            Text = "찾기";
            FormBorderStyle = FormBorderStyle.FixedToolWindow;
            StartPosition = FormStartPosition.Manual;
            ShowInTaskbar = false;
            MaximizeBox = false;
            MinimizeBox = false;
            ClientSize = new Size(452, 232);
            BackColor = BG;
            ForeColor = FG;
            Font = new Font("맑은 고딕", 9f);
            KeyPreview = true;

            // ---- 위쪽 탭 ----
            SetupTab(btTabFind, "찾기", 10);
            SetupTab(btTabRepl, "바꾸기", 86);
            btTabFind.Click += (s, e) => SetMode(false);
            btTabRepl.Click += (s, e) => SetMode(true);
            Controls.Add(btTabFind);
            Controls.Add(btTabRepl);

            // ---- 입력칸 ----
            var lbFind = Cap("찾을 내용", 12, 48);
            Controls.Add(lbFind);
            SetupBox(tbFind, 86, 45, 352);
            Controls.Add(tbFind);

            lbReplCap.Text = "바꿀 내용";
            lbReplCap.ForeColor = DIM;
            lbReplCap.AutoSize = true;
            lbReplCap.Location = new Point(12, 76);
            Controls.Add(lbReplCap);
            SetupBox(tbRepl, 86, 73, 352);
            Controls.Add(tbRepl);

            // ---- 선택 항목 ----
            SetupCheck(cbHl, "찾은 모든 항목 강조", 12, 106, true);
            SetupCheck(cbCase, "대/소문자 일치", 12, 128, false);
            SetupCheck(cbWord, "모든 단어 일치", 12, 150, false);
            SetupCheck(cbRe, "정규식", 12, 172, false);
            Controls.Add(cbHl); Controls.Add(cbCase); Controls.Add(cbWord); Controls.Add(cbRe);

            var gbDir = Group("방향", 196, 102, 76, 60);
            SetupRadio(rbUp, "위", 8, 18, false);
            SetupRadio(rbDown, "아래", 8, 38, true);
            gbDir.Controls.Add(rbUp); gbDir.Controls.Add(rbDown);
            Controls.Add(gbDir);

            var gbScope = Group("범위", 280, 102, 76, 60);
            SetupRadio(rbRow, "이 글", 8, 18, true);
            SetupRadio(rbTab, "이 탭", 8, 38, false);
            gbScope.Controls.Add(rbRow); gbScope.Controls.Add(rbTab);
            Controls.Add(gbScope);

            // ---- 단추 ----
            SetupBtn(btNext, "다음 찾기", 364, 104, true);
            SetupBtn(btCount, "모두 세기", 364, 132, false);
            SetupBtn(btRep, "바꾸기", 364, 160, false);
            SetupBtn(btRepAll, "모두 바꾸기", 364, 188, false);
            SetupBtn(btClose, "닫기", 196, 190, false);
            btClose.Width = 76;
            Controls.Add(btNext); Controls.Add(btCount);
            Controls.Add(btRep); Controls.Add(btRepAll); Controls.Add(btClose);

            lbStat.ForeColor = DIM;
            lbStat.AutoSize = false;
            lbStat.Location = new Point(12, 210);
            lbStat.Size = new Size(340, 16);
            Controls.Add(lbStat);

            // ---- 동작 ----
            btNext.Click += (s, e) => Fire("next");
            btCount.Click += (s, e) => Fire("count");
            btRep.Click += (s, e) => Fire("rep");
            btRepAll.Click += (s, e) => Fire("repall");
            btClose.Click += (s, e) => Hide();

            tbFind.TextChanged += (s, e) => { if (!quiet) Fire("change"); };
            EventHandler opt = (s, e) => { if (!quiet) Fire("change"); };
            cbHl.CheckedChanged += opt; cbCase.CheckedChanged += opt;
            cbWord.CheckedChanged += opt; cbRe.CheckedChanged += opt;
            rbRow.CheckedChanged += opt; rbTab.CheckedChanged += opt;

            tbFind.KeyDown += (s, e) =>
            {
                if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; Fire(e.Shift ? "prev" : "next"); }
            };
            tbRepl.KeyDown += (s, e) =>
            {
                if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; Fire("rep"); }
            };
            KeyDown += (s, e) =>
            {
                if (e.KeyCode == Keys.Escape) { e.SuppressKeyPress = true; Hide(); }
                else if (e.KeyCode == Keys.F3) { e.SuppressKeyPress = true; Fire(e.Shift ? "prev" : "next"); }
            };

            FormClosing += (s, e) =>
            {
                if (e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; Hide(); }
            };

            SetMode(false);
        }

        void Fire(string what) { if (OnAction != null) OnAction(what); }

        Label Cap(string t, int x, int y)
        {
            return new Label { Text = t, ForeColor = DIM, AutoSize = true, Location = new Point(x, y) };
        }

        GroupBox Group(string t, int x, int y, int w, int h)
        {
            return new GroupBox
            {
                Text = t, ForeColor = DIM, Location = new Point(x, y),
                Size = new Size(w, h), FlatStyle = FlatStyle.Flat
            };
        }

        void SetupTab(Button b, string t, int x)
        {
            b.Text = t;
            b.Location = new Point(x, 8);
            b.Size = new Size(72, 26);
            b.FlatStyle = FlatStyle.Flat;
            b.FlatAppearance.BorderSize = 1;
            b.TabStop = false;
        }

        void SetupBox(TextBox b, int x, int y, int w)
        {
            b.Location = new Point(x, y);
            b.Width = w;
            b.BackColor = BG2;
            b.ForeColor = FG;
            b.BorderStyle = BorderStyle.FixedSingle;
            b.Font = new Font("Consolas", 9.5f);
        }

        void SetupCheck(CheckBox c, string t, int x, int y, bool on)
        {
            c.Text = t; c.Location = new Point(x, y); c.AutoSize = true;
            c.ForeColor = FG; c.Checked = on; c.FlatStyle = FlatStyle.Flat;
        }

        void SetupRadio(RadioButton r, string t, int x, int y, bool on)
        {
            r.Text = t; r.Location = new Point(x, y); r.AutoSize = true;
            r.ForeColor = FG; r.Checked = on; r.FlatStyle = FlatStyle.Flat;
        }

        void SetupBtn(Button b, string t, int x, int y, bool prim)
        {
            b.Text = t; b.Location = new Point(x, y); b.Size = new Size(76, 24);
            b.FlatStyle = FlatStyle.Flat;
            b.FlatAppearance.BorderColor = prim ? ACC : LINE;
            b.BackColor = prim ? ACC : BG2;
            b.ForeColor = prim ? Color.White : FG;
            b.TabStop = false;
        }

        public void SetMode(bool repl)
        {
            replMode = repl;
            Text = repl ? "바꾸기" : "찾기";
            lbReplCap.Visible = repl;
            tbRepl.Visible = repl;
            btRep.Visible = repl;
            btRepAll.Visible = repl;

            btTabFind.BackColor = repl ? BG : BG2;
            btTabFind.ForeColor = repl ? DIM : ACC;
            btTabFind.FlatAppearance.BorderColor = repl ? LINE : ACC;
            btTabRepl.BackColor = repl ? BG2 : BG;
            btTabRepl.ForeColor = repl ? ACC : DIM;
            btTabRepl.FlatAppearance.BorderColor = repl ? ACC : LINE;

            if (repl) tbRepl.Focus(); else tbFind.Focus();
        }

        public bool ReplMode { get { return replMode; } }

        public void SetStatus(string text, bool bad)
        {
            lbStat.Text = text ?? "";
            lbStat.ForeColor = bad ? ColorTranslator.FromHtml("#ff6b6b") : DIM;
        }

        public void FocusQuery()
        {
            if (replMode) { tbRepl.Focus(); tbRepl.SelectAll(); }
            else { tbFind.Focus(); tbFind.SelectAll(); }
        }

        protected override bool ShowWithoutActivation { get { return false; } }
    }

    /* =========================== 트리거 띠 =========================== */

    /// 숨김 상태에서 화면 우측 끝에 남는 9px 띠. 마우스를 올리면 패널이 나온다.
    class TriggerForm : Form
    {
        public Action OnHover;

        public TriggerForm()
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            MinimumSize = new Size(1, 1);
            DoubleBuffered = true;
            Cursor = Cursors.Hand;
        }

        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                cp.ExStyle |= 0x08000000 /*WS_EX_NOACTIVATE*/ | 0x00000080 /*WS_EX_TOOLWINDOW*/;
                return cp;
            }
        }
        protected override bool ShowWithoutActivation { get { return true; } }

        protected override void OnPaint(PaintEventArgs e)
        {
            using (var b = new LinearGradientBrush(ClientRectangle,
                       ColorTranslator.FromHtml("#4da3ff"), ColorTranslator.FromHtml("#2a6fb3"), 90f))
                e.Graphics.FillRectangle(b, ClientRectangle);

            int h = Math.Min(54, ClientSize.Height / 3);
            var dot = new Rectangle((ClientSize.Width - 3) / 2, (ClientSize.Height - h) / 2, 3, h);
            using (var b2 = new SolidBrush(Color.FromArgb(150, 255, 255, 255)))
                e.Graphics.FillRectangle(b2, dot);
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            if (OnHover != null) OnHover();
        }
        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (OnHover != null) OnHover();
        }
    }

    /* =========================== 패널 =========================== */

    class PanelForm : Form
    {
        public WebView2 Web;
        public Action<int> OnHotkey;

        public PanelForm()
        {
            Text = "짱디터";
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = true;
            TopMost = false;      // 고정 여부에 따라 AppContext 에서 정한다
            StartPosition = FormStartPosition.Manual;
            MinimumSize = new Size(1, 1);
            BackColor = ColorTranslator.FromHtml("#14161c");
            KeyPreview = false;

            Web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = BackColor };
            Controls.Add(Web);
        }

        /// 띠에 마우스를 올려 나타날 때는 다른 프로그램의 포커스를 뺏지 않는다.
        /// 포커스가 필요한 경우(클릭·단축키)에는 Activate() 를 따로 부른다.
        protected override bool ShowWithoutActivation { get { return true; } }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == Native.WM_HOTKEY && OnHotkey != null) OnHotkey((int)m.WParam);
            else if (m.Msg == Native.WM_JJ_SHOW && OnHotkey != null) OnHotkey(-1);
            base.WndProc(ref m);
        }
    }
}
