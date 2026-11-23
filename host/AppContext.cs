// 짱디터 - 앱 본체: 창 도킹, 자동 숨김, 트레이, 단축키, 화면(JS)과의 다리
using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Text;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;

namespace JJ
{
    class AppContext : ApplicationContext
    {
        const int STRIP = 9;          // 트리거 띠 폭
        const int SEED_W = 40;        // 슬라이드 시작 폭
        const int MIN_W = 320, MAX_W = 1100;
        const int HOTKEY_ID = 1;

        Prefs prefs;
        PanelForm panel;
        TriggerForm trigger;
        NotifyIcon tray;
        Icon appIcon;

        bool collapsed, quitting, webReady;
        DateTime lastCollapse = DateTime.MinValue;

        Timer anim;
        int animFrom, animTo, animDur;
        DateTime animStart;
        Action animDone;

        /* ---------------- 시작 ---------------- */

        public AppContext()
        {
            prefs = Prefs.Load();
            appIcon = LoadIcon();

            panel = new PanelForm { Icon = appIcon };
            panel.OnHotkey = OnHotkey;
            panel.FormClosing += (s, e) =>
            {
                if (quitting) return;
                e.Cancel = true;
                panel.Hide();
                HideTrigger();
            };
            panel.Deactivate += (s, e) =>
            {
                if (prefs.Pinned || !panel.Visible) return;
                var t = new Timer { Interval = 300 };
                t.Tick += (s2, e2) =>
                {
                    t.Stop(); t.Dispose();
                    if (!prefs.Pinned && panel.Visible && !panel.ContainsFocus) CollapseIfMouseAway("포커스");
                };
                t.Start();
            };

            // 제목줄로 끌어다 놓으면 그 모니터 우측에 다시 도킹한다
            panel.ResizeEnd += (s, e) =>
            {
                if (collapsed || !panel.Visible) return;
                RememberScreen(Screen.FromRectangle(panel.Bounds));
                var want = PanelBounds(prefs.Width);
                if (panel.Bounds != want) panel.Bounds = want;
                SendState();
            };

            // 쓰는 모니터를 이름+영역으로 기록해 둔다.
            // (윈도우가 모니터 번호를 다시 매겨도 같은 자리를 찾아가도록)
            RememberScreen(TargetScreen());

            panel.Bounds = PanelBounds(CurWidth());
            panel.Show();
            ApplyTopmost();
            // 고정 상태면 맨 앞에 두지는 않되, 시작할 때 한 번은 보이게 올려 준다
            if (prefs.Pinned) Native.BringToFront(panel);
            StartAwayWatch();
            Native.RegisterHotKey(panel.Handle, HOTKEY_ID, Native.MOD_ALT | Native.MOD_SHIFT, (uint)Keys.J);

            BuildTray();
            InitWeb();

            if (!prefs.Pinned)
            {
                var t = new Timer { Interval = 1800 };
                t.Tick += (s, e) => { t.Stop(); t.Dispose(); if (!prefs.Pinned) Collapse(true); };
                t.Start();
            }

            if (prefs.AutoUpdate && !string.IsNullOrEmpty(prefs.UpdateUrl))
            {
                var t = new Timer { Interval = 8000 };
                t.Tick += (s, e) => { t.Stop(); t.Dispose(); CheckUpdate(false); };
                t.Start();
            }
        }

        Icon LoadIcon()
        {
            try
            {
                var asm = Assembly.GetExecutingAssembly();
                var n = asm.GetManifestResourceNames().FirstOrDefault(x => x.EndsWith("icon.ico", StringComparison.OrdinalIgnoreCase));
                if (n != null) using (var s = asm.GetManifestResourceStream(n)) return new Icon(s);
            }
            catch { }
            return SystemIcons.Application;
        }

        /* ---------------- 화면(WebView2) ---------------- */

        async void InitWeb()
        {
            try
            {
                var udf = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "JJangditer", "wv2");
                var opts = new CoreWebView2EnvironmentOptions(
                    "--disable-features=Translate,MediaSessionService,HardwareMediaKeyHandling" +
                    (prefs.LowResource ? " --disable-gpu --disable-gpu-compositing" : ""));
                var env = await CoreWebView2Environment.CreateAsync(null, udf, opts);
                await panel.Web.EnsureCoreWebView2Async(env);

                var c = panel.Web.CoreWebView2;
                c.SetVirtualHostNameToFolderMapping("jjangditer.local", Assets.WebDir,
                    CoreWebView2HostResourceAccessKind.Allow);
                c.Settings.AreDefaultContextMenusEnabled = false;
                c.Settings.AreBrowserAcceleratorKeysEnabled = false;
                c.Settings.IsStatusBarEnabled = false;
                c.Settings.IsSwipeNavigationEnabled = false;
                c.Settings.IsZoomControlEnabled = false;
#if DEBUG
                c.Settings.AreDevToolsEnabled = true;
#else
                c.Settings.AreDevToolsEnabled = false;
#endif
                c.WebMessageReceived += OnWebMessage;
                c.NewWindowRequested += (s, e) =>
                {
                    e.Handled = true;
                    try { System.Diagnostics.Process.Start(e.Uri); } catch { }
                };
                c.Navigate("https://jjangditer.local/index.html");
                webReady = true;
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "WebView2 를 시작하지 못했습니다.\n\n" + ex.Message +
                    "\n\n윈도우의 'Microsoft Edge WebView2 Runtime' 이 필요합니다.",
                    "짱디터", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Quit();
            }
        }

        void Post(object o)
        {
            if (!webReady || panel.Web.CoreWebView2 == null) return;
            try { panel.Web.CoreWebView2.PostWebMessageAsJson(Store.JS.Serialize(o)); } catch { }
        }

        void Reply(int id, object r, string err)
        {
            var d = new Dictionary<string, object> { { "id", id } };
            if (err != null) d["e"] = err; else d["r"] = r;
            Post(d);
        }

        /// 오래 걸리는 일은 이 값을 돌려주고, 끝난 뒤에 따로 답을 보낸다
        static readonly object PENDING = new object();

        void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            int id = 0;
            try
            {
                var msg = Store.JS.Deserialize<Dictionary<string, object>>(e.WebMessageAsJson);
                id = Convert.ToInt32(msg["id"], CultureInfo.InvariantCulture);
                var m = Convert.ToString(msg["m"]);
                object av; msg.TryGetValue("a", out av);
                var a = (av as ArrayList) ?? new ArrayList();
                var r = Dispatch(m, a, id);
                if (!ReferenceEquals(r, PENDING)) Reply(id, r, null);
            }
            catch (Exception ex)
            {
                Reply(id, null, ex.Message);
            }
        }

        static string S(ArrayList a, int i) { return a.Count > i && a[i] != null ? Convert.ToString(a[i]) : null; }
        static int I(ArrayList a, int i, int def)
        {
            try { return a.Count > i && a[i] != null ? Convert.ToInt32(a[i], CultureInfo.InvariantCulture) : def; }
            catch { return def; }
        }
        static bool B(ArrayList a, int i, bool def)
        {
            try { return a.Count > i && a[i] != null ? Convert.ToBoolean(a[i]) : def; }
            catch { return def; }
        }

        object Dispatch(string m, ArrayList a, int reqId)
        {
            switch (m)
            {
                case "getState": return StateObj(true);

                case "setPinned":
                    prefs.Pinned = B(a, 0, true); prefs.Save();
                    ApplyTopmost();
                    if (prefs.Pinned) { Expand(true); panel.Activate(); } else Collapse(true);
                    SendState(); return prefs.Pinned;

                case "expand":
                    if (collapsed && (DateTime.Now - lastCollapse).TotalMilliseconds < 350) return null;
                    Expand(true); return null;

                case "collapse":
                    if (!prefs.Pinned && !prefs.Maximized) CollapseIfMouseAway("화면"); return null;

                case "setWidth":
                    prefs.Width = Math.Max(MIN_W, Math.Min(MAX_W, I(a, 0, prefs.Width)));
                    prefs.Maximized = false; prefs.RestoreWidth = 0;
                    prefs.Save();
                    if (!collapsed) panel.Bounds = PanelBounds(prefs.Width);
                    SendState(); return prefs.Width;

                case "toggleMax": ToggleMax(); return prefs.Maximized;

                case "nextDisplay": return NextDisplay();

                case "dragWindow": StartDragLoop(); return null;

                case "hide": panel.Hide(); HideTrigger(); return null;
                case "quit": Quit(); return null;
                case "focus": panel.Activate(); return null;

                case "setPrefs": return SetPrefs(a);

                case "copy":
                    {
                        var t = S(a, 0) ?? "";
                        try { if (t.Length > 0) Clipboard.SetText(t); else Clipboard.Clear(); } catch { }
                        return true;
                    }

                case "paste":
                    try { return Clipboard.ContainsText() ? Clipboard.GetText() : ""; }
                    catch { return ""; }

                case "findShow": return ShowFindForm(S(a, 0), S(a, 1));
                case "findHide":
                    if (findForm != null && !findForm.IsDisposed) findForm.Hide();
                    return true;
                case "findStatus":
                    if (findForm != null && !findForm.IsDisposed)
                        findForm.SetStatus(S(a, 0), B(a, 1, false));
                    return true;
                case "findOpts": return FindOpts();
                case "findVisible":
                    return findForm != null && !findForm.IsDisposed && findForm.Visible;

                case "myTemplates": return MyTemplates();
                case "readTemplate": return ReadTemplate(S(a, 0));
                case "saveTemplate": return SaveTemplate(S(a, 0), S(a, 1));
                case "openTemplateDir":
                    {
                        var d = TemplateDir();
                        try { System.Diagnostics.Process.Start("explorer.exe", "\"" + d + "\""); } catch { }
                        return d;
                    }

                case "load": return Store.LoadWorkspace();
                case "save": return Store.SaveWorkspace(S(a, 0));

                case "exportTab": return SaveDialog(S(a, 0), ".jjt", "짱디터 탭 (*.jjt)|*.jjt|JSON (*.json)|*.json", S(a, 1), "탭 내보내기");
                case "exportAll": return SaveDialog("jjangditer-workspace", ".jjw", "짱디터 워크스페이스 (*.jjw)|*.jjw|JSON (*.json)|*.json", S(a, 0), "전체 내보내기");
                case "exportText": return SaveDialog(S(a, 0), ".md", "Markdown (*.md)|*.md|텍스트 (*.txt)|*.txt", S(a, 1), "텍스트로 저장");
                case "import": return ImportDialog();

                case "openText": return OpenTextDialog();
                case "findInFiles":
                    StartFindInFiles(a.Count > 0 ? a[0] as Dictionary<string, object> : null, reqId);
                    return PENDING;
                case "findInFilesCancel":
                    fifCancel = true;
                    return true;
                case "readText":
                    {
                        var path = S(a, 0);
                        if (string.IsNullOrEmpty(path) || !File.Exists(path))
                            return new Dictionary<string, object> { { "ok", false }, { "error", "파일이 없습니다: " + path } };
                        try
                        {
                            string enc;
                            var txt = Store.ReadUserText(path, out enc);
                            return new Dictionary<string, object> {
                                { "ok", true }, { "text", txt }, { "path", path }, { "enc", enc } };
                        }
                        catch (Exception ex)
                        {
                            return new Dictionary<string, object> { { "ok", false }, { "error", ex.Message } };
                        }
                    }
                case "saveTextAs":
                    return SaveTextDialog(S(a, 0), S(a, 1), S(a, 2));
                case "saveTextTo":
                    {
                        var path = S(a, 0);
                        if (string.IsNullOrEmpty(path))
                            return new Dictionary<string, object> { { "ok", false } };
                        bool ok = Store.WriteUserText(path, S(a, 1) ?? "", S(a, 2));
                        if (ok) Remember(path);
                        return new Dictionary<string, object> { { "ok", ok }, { "path", path } };
                    }

                case "confirm3":
                    {
                        var body = S(a, 0) ?? "";
                        var detail = S(a, 1);
                        if (!string.IsNullOrEmpty(detail)) body += Environment.NewLine + Environment.NewLine + detail;
                        var res = MessageBox.Show(panel, body, "짱디터",
                            MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question);
                        return res == DialogResult.Yes ? "yes" : (res == DialogResult.No ? "no" : "cancel");
                    }

                case "confirm":
                    {
                        var body = S(a, 0) ?? "진행할까요?";
                        var detail = S(a, 1);
                        if (!string.IsNullOrEmpty(detail)) body += "\n\n" + detail;
                        return MessageBox.Show(panel, body, "짱디터",
                            MessageBoxButtons.OKCancel, MessageBoxIcon.Question) == DialogResult.OK;
                    }

                case "openDataDir":
                    try { System.Diagnostics.Process.Start("explorer.exe", Store.DataDir); } catch { }
                    return null;

                case "browseFolder":
                    using (var d = new FolderBrowserDialog
                    {
                        Description = S(a, 0) ?? "폴더 선택",
                        ShowNewFolderButton = true,
                        SelectedPath = Directory.Exists(S(a, 1) ?? "") ? S(a, 1) : DefaultDir()
                    })
                        return d.ShowDialog(panel) == DialogResult.OK ? d.SelectedPath : null;

                case "getStartup": return Startup.IsOn();
                case "setStartup": return Startup.Set(B(a, 0, false));

                case "updateInfo":
                    return new Dictionary<string, object> {
                        { "version", Application.ProductVersion },
                        { "updateUrl", prefs.UpdateUrl },
                        { "autoUpdate", prefs.AutoUpdate },
                        { "lowResource", prefs.LowResource },
                        { "pending", pendingVersion }
                    };
                case "updateConfig":
                    {
                        var d = a.Count > 0 ? a[0] as Dictionary<string, object> : null;
                        if (d != null)
                        {
                            object v;
                            if (d.TryGetValue("updateUrl", out v) && v != null) prefs.UpdateUrl = Convert.ToString(v).Trim();
                            if (d.TryGetValue("autoUpdate", out v) && v != null) prefs.AutoUpdate = Convert.ToBoolean(v);
                            prefs.Save();
                        }
                        return new Dictionary<string, object> { { "updateUrl", prefs.UpdateUrl }, { "autoUpdate", prefs.AutoUpdate } };
                    }
                case "checkUpdate": CheckUpdate(true); return null;
                case "applyUpdate": ApplyUpdate(); return null;
            }
            throw new Exception("알 수 없는 요청: " + m);
        }

        object SetPrefs(ArrayList a)
        {
            var d = a.Count > 0 ? a[0] as Dictionary<string, object> : null;
            if (d != null)
            {
                object v;
                if (d.TryGetValue("theme", out v) && v != null) prefs.Theme = Convert.ToString(v);
                if (d.TryGetValue("hideDelay", out v) && v != null) prefs.HideDelay = Convert.ToInt32(v, CultureInfo.InvariantCulture);
                if (d.TryGetValue("lowResource", out v) && v != null) prefs.LowResource = Convert.ToBoolean(v);
                if (d.TryGetValue("width", out v) && v != null) prefs.Width = Convert.ToInt32(v, CultureInfo.InvariantCulture);
                if (d.TryGetValue("triggerZone", out v) && v != null)
                {
                    prefs.TriggerZone = Math.Max(0, Math.Min(3, Convert.ToInt32(v, CultureInfo.InvariantCulture)));
                    if (trigger != null && !trigger.IsDisposed) trigger.Bounds = TriggerBounds();
                }
                prefs.Save();
                SendState();
            }
            return StateObj(false);
        }

        /* ---------------- 상태 ---------------- */

        Dictionary<string, object> StateObj(bool full)
        {
            var d = new Dictionary<string, object> {
                { "pinned", prefs.Pinned }, { "collapsed", collapsed }, { "width", prefs.Width },
                { "theme", prefs.Theme }, { "hideDelay", prefs.HideDelay }, { "strip", STRIP },
                { "lowResource", prefs.LowResource }, { "maximized", prefs.Maximized },
                { "triggerZone", prefs.TriggerZone }
            };
            if (full)
            {
                d["version"] = Application.ProductVersion;
                d["dataDir"] = Store.DataDir;
            }
            return d;
        }

        void SendState()
        {
            Post(new Dictionary<string, object> { { "ev", "state" }, { "d", StateObj(false) } });
            if (tray != null) tray.Text = "짱디터 - " + (prefs.Pinned ? "고정됨" : "자동 숨김");
        }

        /* ---------------- 창 위치 / 접기 펼치기 ---------------- */

        static string RectKey(Screen s)
        {
            var w = s.WorkingArea;
            return w.X + "," + w.Y + "," + w.Width + "," + w.Height;
        }

        /// 패널을 붙일 모니터.
        /// 1) 기억해 둔 이름  2) 이름이 안 맞으면 기억해 둔 화면 영역  3) 주 모니터
        Screen TargetScreen()
        {
            if (!string.IsNullOrEmpty(prefs.DisplayId))
            {
                var byName = Screen.AllScreens.FirstOrDefault(x => x.DeviceName == prefs.DisplayId);
                if (byName != null && (string.IsNullOrEmpty(prefs.DisplayRect)
                                       || RectKey(byName) == prefs.DisplayRect))
                    return byName;
            }
            if (!string.IsNullOrEmpty(prefs.DisplayRect))
            {
                // 번호가 바뀌었어도 같은 자리/크기의 모니터를 찾는다
                var byRect = Screen.AllScreens.FirstOrDefault(x => RectKey(x) == prefs.DisplayRect);
                if (byRect != null)
                {
                    prefs.DisplayId = byRect.DeviceName;
                    prefs.Save();
                    return byRect;
                }
            }
            return Screen.PrimaryScreen;
        }

        /// 지금 쓰는 모니터를 이름과 영역 둘 다로 기억해 둔다
        void RememberScreen(Screen s)
        {
            if (s == null) return;
            if (prefs.DisplayId != s.DeviceName || prefs.DisplayRect != RectKey(s))
            {
                prefs.DisplayId = s.DeviceName;
                prefs.DisplayRect = RectKey(s);
                prefs.Save();
            }
        }

        Rectangle PanelBounds(int w)
        {
            var wa = TargetScreen().WorkingArea;
            w = Math.Max(1, Math.Min(wa.Width, w));
            return new Rectangle(wa.Right - w, wa.Top, w, wa.Height);
        }

        /// 자동 숨김일 때만 맨 앞에 둔다.
        /// 고정(📌) 했으면 보통 창처럼 다른 프로그램이 위로 올라올 수 있다.
        void ApplyTopmost()
        {
            Native.SetTopmost(panel, !prefs.Pinned);
        }

        /// 지금 펼쳐야 할 폭 (최대화 중이면 화면 전체)
        int CurWidth()
        {
            return prefs.Maximized ? TargetScreen().WorkingArea.Width
                                   : Math.Min(MAX_W, prefs.Width);
        }

        /// 화면 전체로 펼치기 / 이전 폭으로 되돌리기
        void ToggleMax()
        {
            if (prefs.Maximized)
            {
                prefs.Maximized = false;
                if (prefs.RestoreWidth >= MIN_W) prefs.Width = Math.Min(MAX_W, prefs.RestoreWidth);
                prefs.RestoreWidth = 0;
                prefs.Save();
                AnimateWidth(CurWidth(), 150, null);
            }
            else
            {
                prefs.RestoreWidth = prefs.Width;
                prefs.Maximized = true;
                prefs.Save();
                HideTrigger();
                if (!panel.Visible) Expand(false);
                AnimateWidth(CurWidth(), 170, null);
                panel.Activate();
            }
            SendState();
        }

        void AnimateWidth(int to, int dur, Action done)
        {
            if (anim != null) { anim.Stop(); anim.Dispose(); anim = null; }
            animFrom = panel.Width; animTo = to; animDur = dur; animStart = DateTime.Now; animDone = done;
            if (Math.Abs(animTo - animFrom) < 2)
            {
                panel.Bounds = PanelBounds(animTo);
                if (done != null) done();
                return;
            }
            anim = new Timer { Interval = 8 };
            anim.Tick += (s, e) =>
            {
                double t = Math.Min(1.0, (DateTime.Now - animStart).TotalMilliseconds / animDur);
                double k = 1 - Math.Pow(1 - t, 3);                       // easeOutCubic
                panel.Bounds = PanelBounds((int)Math.Round(animFrom + (animTo - animFrom) * k));
                if (t >= 1.0)
                {
                    anim.Stop(); anim.Dispose(); anim = null;
                    panel.Bounds = PanelBounds(animTo);
                    var d = animDone; animDone = null;
                    if (d != null) d();
                }
            };
            anim.Start();
        }

        void Expand(bool animate)
        {
            collapsed = false;
            HideTrigger();
            if (!panel.Visible)
            {
                panel.Bounds = PanelBounds(animate ? SEED_W : CurWidth());
                panel.Show();
                ApplyTopmost();
            }
            if (animate) AnimateWidth(CurWidth(), 170, null);
            else panel.Bounds = PanelBounds(CurWidth());
            SendState();
        }

        /* ---------------- 제목줄로 창 끌기 ----------------
         * WebView2 가 창을 덮고 있어 폼이 마우스를 직접 못 받고,
         * 마우스 캡처도 WebView2 쪽이 쥐고 있어 ReleaseCapture 방식이 통하지 않는다.
         * 그래서 버튼이 눌려 있는 동안 커서를 따라가도록 직접 움직인다.
         */
        Timer dragTimer;
        Point dragCursor, dragWin;

        void StartDragLoop()
        {
            if (dragTimer != null || collapsed || !panel.Visible) return;
            dragCursor = Cursor.Position;
            dragWin = panel.Location;
            dragTimer = new Timer { Interval = 10 };
            dragTimer.Tick += (s, e) =>
            {
                if ((Native.GetAsyncKeyState(Native.VK_LBUTTON) & 0x8000) == 0)
                {
                    dragTimer.Stop(); dragTimer.Dispose(); dragTimer = null;
                    EndDragLoop();
                    return;
                }
                var p = Cursor.Position;
                panel.Location = new Point(dragWin.X + (p.X - dragCursor.X),
                                           dragWin.Y + (p.Y - dragCursor.Y));
            };
            dragTimer.Start();
        }

        /// 끌어다 놓은 모니터의 우측에 다시 도킹한다
        void EndDragLoop()
        {
            RememberScreen(Screen.FromRectangle(panel.Bounds));
            panel.Bounds = PanelBounds(CurWidth());
            if (trigger != null && !trigger.IsDisposed) trigger.Bounds = TriggerBounds();
            SendState();
        }

        /* ---------------- 커서 감시 ----------------
         * 패널이 떠 있는데 마우스가 한 번도 들어오지 않으면
         * 웹 화면은 mouseleave 를 낼 수 없고, 포커스를 가진 적이 없으니
         * Deactivate 도 오지 않는다. 그래서 커서 위치를 직접 지켜본다.
         */
        Timer awayTimer;
        DateTime awaySince = DateTime.MinValue;

        void StartAwayWatch()
        {
            if (awayTimer != null) return;
            awayTimer = new Timer { Interval = 250 };
            awayTimer.Tick += (s, e) =>
            {
                // 접을 이유가 없는 상황들
                if (prefs.Pinned || prefs.Maximized || collapsed
                    || panel == null || panel.IsDisposed || !panel.Visible
                    || dragTimer != null || anim != null
                    || (findForm != null && !findForm.IsDisposed && findForm.Visible)
                    || Native.ForegroundIsOurs())        // 짱디터를 쓰는 중 (대화상자 포함)
                {
                    awaySince = DateTime.MinValue;
                    return;
                }

                // 커서가 패널 위에 있으면 그대로 둔다
                if (panel.Bounds.Contains(Cursor.Position))
                {
                    awaySince = DateTime.MinValue;
                    return;
                }

                if (awaySince == DateTime.MinValue) { awaySince = DateTime.Now; return; }
                if ((DateTime.Now - awaySince).TotalMilliseconds < Math.Max(200, prefs.HideDelay)) return;

                awaySince = DateTime.MinValue;
                Collapse(true);
            };
            awayTimer.Start();
        }

        /// 마우스가 아직 패널 위에 있으면 접지 않는다.
        /// (창 크기가 변하는 순간 브라우저가 가짜 mouseleave 를 내는 경우가 있다)
        void CollapseIfMouseAway(string why)
        {
            if (dragTimer != null || prefs.Maximized) return;
            // 찾기 창을 쓰는 중이면 패널이 사라지면 안 된다
            if (findForm != null && !findForm.IsDisposed && findForm.Visible) return;
            if (panel.Visible && panel.Bounds.Contains(Cursor.Position)) return;
            Collapse(true);
        }

        void Collapse(bool animate)
        {
            collapsed = true;
            Action fin = () =>
            {
                if (!collapsed) return;
                panel.Hide();
                ShowTrigger();
                lastCollapse = DateTime.Now;
            };
            if (animate && panel.Visible) AnimateWidth(SEED_W, 140, fin);
            else fin();
            SendState();
        }

        /// 띠가 차지할 세로 비율 (0 = 화면 전체)
        static double ZoneRatio(int zone)
        {
            switch (zone)
            {
                case 1: return 0.70;   // 넓게
                case 2: return 0.50;   // 가운데 (기본)
                case 3: return 0.30;   // 좁게
                default: return 1.0;   // 전체
            }
        }

        Rectangle TriggerBounds()
        {
            var wa = TargetScreen().WorkingArea;
            var ratio = ZoneRatio(prefs.TriggerZone);
            if (ratio >= 0.999) return new Rectangle(wa.Right - STRIP, wa.Top, STRIP, wa.Height);

            // 화면 한가운데에 띠를 둔다. 위쪽 X 버튼 자리를 비워 두기 위함.
            int h = Math.Max(120, (int)Math.Round(wa.Height * ratio));
            int top = wa.Top + (wa.Height - h) / 2;
            return new Rectangle(wa.Right - STRIP, top, STRIP, h);
        }

        void ShowTrigger()
        {
            if (trigger == null || trigger.IsDisposed)
            {
                trigger = new TriggerForm();
                trigger.OnHover = () =>
                {
                    Expand(true);
                };
            }
            trigger.Bounds = TriggerBounds();
            if (!trigger.Visible) trigger.Show();
            Native.Topmost(trigger);
        }

        void HideTrigger()
        {
            if (trigger == null || trigger.IsDisposed) return;
            if (prefs.Pinned) { trigger.Dispose(); trigger = null; return; }
            if (trigger.Visible) trigger.Hide();
        }

        object NextDisplay()
        {
            var all = Screen.AllScreens;
            if (all.Length < 2) return new Dictionary<string, object> { { "count", 1 }, { "name", "모니터 1" } };
            int cur = Array.FindIndex(all, x => x.DeviceName == TargetScreen().DeviceName);
            int idx = (cur + 1) % all.Length;
            RememberScreen(all[idx]);
            prefs.Save();
            collapsed = false;
            HideTrigger();
            if (!panel.Visible) panel.Show();
            panel.Bounds = PanelBounds(prefs.Width);
            panel.Activate();
            SendState();
            var b = all[idx].Bounds;
            return new Dictionary<string, object> {
                { "count", all.Length }, { "index", idx + 1 },
                { "name", "모니터 " + (idx + 1) + " (" + b.Width + "×" + b.Height + ")" }
            };
        }

        void OnHotkey(int id)
        {
            if (collapsed || !panel.Visible) { Expand(true); panel.Activate(); }
            else if (!prefs.Pinned) Collapse(true);
            else panel.Activate();
        }

        /* ---------------- 찾기 창 ---------------- */

        FindForm findForm;

        FindForm EnsureFindForm()
        {
            if (findForm != null && !findForm.IsDisposed) return findForm;
            findForm = new FindForm();
            findForm.Owner = panel;              // 패널 위에 머물되, 창 밖으로도 끌어낼 수 있다
            findForm.OnAction = (what) =>
            {
                Post(new Dictionary<string, object> {
                    { "ev", "fd" }, { "k", what },
                    { "d", FindOpts() }
                });
            };
            return findForm;
        }

        Dictionary<string, object> FindOpts()
        {
            var f = findForm;
            if (f == null || f.IsDisposed) return new Dictionary<string, object>();
            return new Dictionary<string, object> {
                { "q", f.Query }, { "r", f.Replacement },
                { "cs", f.MatchCase }, { "word", f.WholeWord }, { "re", f.UseRegex },
                { "hl", f.Hilite }, { "up", f.DirUp }, { "tab", f.ScopeTab },
                { "repl", f.ReplMode }
            };
        }

        /// 찾기 창을 띄운다. 패널 오른쪽 바깥쪽에 놓아 글을 가리지 않게 한다.
        object ShowFindForm(string mode, string preset)
        {
            var f = EnsureFindForm();
            f.SetMode(mode == "repl");
            if (!string.IsNullOrEmpty(preset)) f.Query = preset;

            if (!f.Visible)
            {
                var wa = TargetScreen().WorkingArea;
                int x = panel.Left - f.Width - 12;
                if (x < wa.Left + 8) x = wa.Left + 8;        // 왼쪽으로 넘치면 화면 안으로
                int y = panel.Top + 140;
                if (y + f.Height > wa.Bottom) y = Math.Max(wa.Top + 8, wa.Bottom - f.Height - 8);
                f.Location = new Point(x, y);
                f.Show(panel);
            }
            f.Activate();
            f.FocusQuery();
            return FindOpts();
        }

        /* ---------------- 내 템플릿 ---------------- */

        /// 내 템플릿을 두는 폴더 (%APPDATA%\JJangditer\templates)
        static string TemplateDir()
        {
            var d = Path.Combine(Store.DataDir, "templates");
            try { Directory.CreateDirectory(d); } catch { }
            return d;
        }

        /// 폴더 안의 .jjt 목록 (이름 / 경로 / 행 수)
        static object MyTemplates()
        {
            var list = new ArrayList();
            try
            {
                foreach (var f in Directory.EnumerateFiles(TemplateDir(), "*.jjt"))
                {
                    int rows = 0;
                    try
                    {
                        var d = Store.JS.Deserialize<Dictionary<string, object>>(File.ReadAllText(f, Encoding.UTF8));
                        object tv;
                        if (d.TryGetValue("tab", out tv))
                        {
                            var tab = tv as Dictionary<string, object>;
                            object rv;
                            if (tab != null && tab.TryGetValue("rows", out rv) && rv is ArrayList)
                                rows = ((ArrayList)rv).Count;
                        }
                    }
                    catch { }
                    list.Add(new Dictionary<string, object> {
                        { "name", Path.GetFileNameWithoutExtension(f) },
                        { "path", f },
                        { "rows", rows }
                    });
                }
            }
            catch { }
            return new Dictionary<string, object> { { "ok", true }, { "dir", TemplateDir() }, { "items", list } };
        }

        static object ReadTemplate(string path)
        {
            try
            {
                return new Dictionary<string, object> {
                    { "ok", true }, { "json", File.ReadAllText(path, Encoding.UTF8) } };
            }
            catch (Exception ex)
            {
                return new Dictionary<string, object> { { "ok", false }, { "error", ex.Message } };
            }
        }

        /// 지금 탭을 내 템플릿으로 저장
        static object SaveTemplate(string name, string json)
        {
            try
            {
                var safe = string.Join("_", (name ?? "내 템플릿").Split(Path.GetInvalidFileNameChars()));
                var f = Path.Combine(TemplateDir(), safe + ".jjt");
                File.WriteAllText(f, json ?? "", new UTF8Encoding(false));
                return new Dictionary<string, object> { { "ok", true }, { "path", f } };
            }
            catch (Exception ex)
            {
                return new Dictionary<string, object> { { "ok", false }, { "error", ex.Message } };
            }
        }

        /* ---------------- 파일 대화상자 ---------------- */

        string DefaultDir()
        {
            try { if (!string.IsNullOrEmpty(prefs.LastDir) && Directory.Exists(prefs.LastDir)) return prefs.LastDir; }
            catch { }
            return Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
        }

        void Remember(string file)
        {
            try
            {
                var d = Path.GetDirectoryName(file);
                if (!string.IsNullOrEmpty(d) && d != prefs.LastDir) { prefs.LastDir = d; prefs.Save(); }
            }
            catch { }
        }

        object SaveDialog(string name, string ext, string filter, string content, string title)
        {
            var safe = string.Join("_", (name ?? "untitled").Split(Path.GetInvalidFileNameChars()));
            using (var d = new SaveFileDialog
            {
                Title = title,
                FileName = safe + ext,
                Filter = filter,
                InitialDirectory = DefaultDir(),
                OverwritePrompt = true
            })
            {
                if (d.ShowDialog(panel) != DialogResult.OK) return new Dictionary<string, object> { { "ok", false } };
                Remember(d.FileName);
                bool ok = Store.WriteText(d.FileName, content ?? "");
                return new Dictionary<string, object> { { "ok", ok }, { "path", d.FileName } };
            }
        }

        object ImportDialog()
        {
            using (var d = new OpenFileDialog
            {
                Title = "불러오기",
                Filter = "짱디터 파일 (*.jjt;*.jjw;*.json)|*.jjt;*.jjw;*.json|모든 파일 (*.*)|*.*",
                Multiselect = true,
                InitialDirectory = DefaultDir()
            })
            {
                if (d.ShowDialog(panel) != DialogResult.OK || d.FileNames.Length == 0)
                    return new Dictionary<string, object> { { "ok", false }, { "items", new ArrayList() } };
                Remember(d.FileNames[0]);
                var items = new ArrayList();
                foreach (var f in d.FileNames)
                {
                    var txt = Store.ReadText(f);
                    if (txt == null) continue;
                    items.Add(new Dictionary<string, object> { { "file", Path.GetFileName(f) }, { "data", txt } });
                }
                return new Dictionary<string, object> { { "ok", items.Count > 0 }, { "items", items } };
            }
        }

        /* ---------------- 파일 내에서 찾기 (폴더 전체) ---------------- */
        static string DS(Dictionary<string, object> d, string k, string def)
        {
            object v;
            return (d != null && d.TryGetValue(k, out v) && v != null) ? Convert.ToString(v) : def;
        }
        static bool DB(Dictionary<string, object> d, string k, bool def)
        {
            object v;
            if (d == null || !d.TryGetValue(k, out v) || v == null) return def;
            try { return Convert.ToBoolean(v); } catch { return def; }
        }

        volatile bool fifCancel;
        volatile bool fifRunning;

        void StartFindInFiles(Dictionary<string, object> d, int reqId)
        {
            if (fifRunning)
            {
                Reply(reqId, new Dictionary<string, object> { { "ok", false }, { "error", "이미 찾는 중입니다" } }, null);
                return;
            }
            fifCancel = false;
            fifRunning = true;

            var th = new System.Threading.Thread(() =>
            {
                object result;
                try
                {
                    result = FindInFiles(d, (scanned, hits, cur) =>
                    {
                        // 화면에 진행 상황 알리기
                        try
                        {
                            if (panel != null && !panel.IsDisposed)
                                panel.BeginInvoke(new Action(() => Post(new Dictionary<string, object> {
                                    { "ev", "fif" }, { "k", "progress" },
                                    { "d", new Dictionary<string, object> {
                                        { "scanned", scanned }, { "hits", hits }, { "file", cur } } }
                                })));
                        }
                        catch { }
                        return !fifCancel;
                    });
                }
                catch (Exception ex)
                {
                    result = new Dictionary<string, object> { { "ok", false }, { "error", ex.Message } };
                }
                fifRunning = false;
                try
                {
                    if (panel != null && !panel.IsDisposed)
                        panel.BeginInvoke(new Action(() => Reply(reqId, result, null)));
                }
                catch { }
            });
            th.IsBackground = true;
            th.Start();
        }

        public static object FindInFiles(Dictionary<string, object> d, Func<int, int, string, bool> onProgress)
        {
            var dir = DS(d, "dir", null);
            var pattern = DS(d, "pattern", "*.txt");
            var q = DS(d, "query", "");
            bool cs = DB(d, "cs", false);
            bool sub = DB(d, "sub", true);
            const int MAX = 3000;
            const long MAX_FILE = 20L * 1024 * 1024;

            if (string.IsNullOrEmpty(q))
                return new Dictionary<string, object> { { "ok", false }, { "error", "찾을 내용을 입력하세요" } };
            if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir))
                return new Dictionary<string, object> { { "ok", false }, { "error", "폴더를 찾을 수 없습니다: " + dir } };

            var pats = (pattern ?? "*.txt")
                .Split(new[] { ';', ',', ' ' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(x => x.Trim()).Where(x => x.Length > 0).ToArray();
            if (pats.Length == 0) pats = new[] { "*.txt" };

            var items = new ArrayList();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            int files = 0, hits = 0, scanned = 0;
            bool cut = false;
            var opt = sub ? SearchOption.AllDirectories : SearchOption.TopDirectoryOnly;
            var cmp = cs ? StringComparison.Ordinal : StringComparison.OrdinalIgnoreCase;

            foreach (var pat in pats)
            {
                if (cut) break;
                IEnumerable<string> list;
                try { list = Directory.EnumerateFiles(dir, pat, opt); }
                catch { continue; }

                foreach (var f in list)
                {
                    if (cut) break;
                    if (!seen.Add(f)) continue;
                    string text, enc;
                    try
                    {
                        var fi = new FileInfo(f);
                        if (fi.Length > MAX_FILE) continue;
                        text = Store.ReadUserText(f, out enc);
                    }
                    catch { continue; }
                    scanned++;

                    // 20개마다 진행 상황을 알리고, 취소했는지 확인한다
                    if (onProgress != null && (scanned % 20 == 0))
                    {
                        if (!onProgress(scanned, hits, f)) { cut = true; break; }
                    }

                    if (text.IndexOf(q, cmp) < 0) continue;

                    var lines = text.Split('\n');
                    bool any = false;
                    for (int i = 0; i < lines.Length; i++)
                    {
                        var line = lines[i].TrimEnd('\r');
                        if (line.IndexOf(q, cmp) < 0) continue;
                        any = true; hits++;
                        items.Add(new Dictionary<string, object> {
                            { "file", f }, { "line", i + 1 },
                            { "text", line.Length > 400 ? line.Substring(0, 400) + " …" : line }
                        });
                        if (items.Count >= MAX) { cut = true; break; }
                    }
                    if (any) files++;
                }
            }

            if (onProgress != null) onProgress(scanned, hits, "");
            return new Dictionary<string, object> {
                { "ok", true }, { "items", items },
                { "files", files }, { "hits", hits }, { "scanned", scanned }, { "truncated", cut }
            };
        }

        object SaveTextDialog(string name, string content, string encName)
        {
            var safe = string.Join("_", (name ?? "untitled").Split(Path.GetInvalidFileNameChars()));
            using (var d = new SaveFileDialog
            {
                Title = "텍스트로 저장",
                FileName = safe + ".txt",
                Filter = "텍스트 파일 (*.txt)|*.txt|모든 파일 (*.*)|*.*",
                InitialDirectory = DefaultDir(),
                OverwritePrompt = true
            })
            {
                if (d.ShowDialog(panel) != DialogResult.OK) return new Dictionary<string, object> { { "ok", false } };
                Remember(d.FileName);
                bool ok = Store.WriteUserText(d.FileName, content ?? "", encName);
                return new Dictionary<string, object> { { "ok", ok }, { "path", d.FileName } };
            }
        }

        object OpenTextDialog()
        {
            using (var d = new OpenFileDialog
            {
                Title = "텍스트 파일 열기",
                Filter = "텍스트 파일 (*.txt;*.log;*.conf;*.cfg;*.ini;*.md;*.sh)|*.txt;*.log;*.conf;*.cfg;*.ini;*.md;*.sh|모든 파일 (*.*)|*.*",
                Multiselect = false,
                InitialDirectory = DefaultDir()
            })
            {
                if (d.ShowDialog(panel) != DialogResult.OK) return new Dictionary<string, object> { { "ok", false } };
                Remember(d.FileName);
                string text, enc;
                try { text = Store.ReadUserText(d.FileName, out enc); }
                catch (Exception ex) { return new Dictionary<string, object> { { "ok", false }, { "error", ex.Message } }; }
                return new Dictionary<string, object> {
                    { "ok", true },
                    { "name", Path.GetFileNameWithoutExtension(d.FileName) },
                    { "path", d.FileName },
                    { "text", text },
                    { "enc", enc }
                };
            }
        }

        /* ---------------- 트레이 ---------------- */

        void BuildTray()
        {
            var menu = new ContextMenuStrip();
            menu.Items.Add("짱디터 열기", null, (s, e) => { Expand(true); panel.Activate(); });
            menu.Items.Add(new ToolStripSeparator());
            var pin = new ToolStripMenuItem("우측에 고정") { CheckOnClick = true, Checked = prefs.Pinned };
            pin.Click += (s, e) =>
            {
                prefs.Pinned = pin.Checked; prefs.Save();
                if (prefs.Pinned) { Expand(true); panel.Activate(); } else Collapse(true);
                SendState();
            };
            menu.Items.Add(pin);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("데이터 폴더 열기", null, (s, e) =>
            {
                try { System.Diagnostics.Process.Start("explorer.exe", Store.DataDir); } catch { }
            });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("종료", null, (s, e) => Quit());

            tray = new NotifyIcon
            {
                Icon = appIcon,
                Text = "짱디터",
                Visible = true,
                ContextMenuStrip = menu
            };
            tray.MouseClick += (s, e) =>
            {
                if (e.Button == MouseButtons.Left) { Expand(true); panel.Activate(); }
            };
        }

        /* ---------------- 업데이트 ---------------- */

        string pendingVersion, pendingFile;

        static bool IsHttp(string u)
        {
            return u.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
                   u.StartsWith("https://", StringComparison.OrdinalIgnoreCase);
        }

        static int CmpVer(string a, string b)
        {
            var pa = (a ?? "0").Split('.', '-', '+');
            var pb = (b ?? "0").Split('.', '-', '+');
            for (int i = 0; i < Math.Max(pa.Length, pb.Length); i++)
            {
                int x = 0, y = 0;
                if (i < pa.Length) int.TryParse(pa[i], out x);
                if (i < pb.Length) int.TryParse(pb[i], out y);
                if (x != y) return x > y ? 1 : -1;
            }
            return 0;
        }

        void UpdEvent(string kind, object d)
        {
            Post(new Dictionary<string, object> { { "ev", "update" }, { "k", kind }, { "d", d } });
        }

        void CheckUpdate(bool manual)
        {
            var baseUrl = (prefs.UpdateUrl ?? "").Trim();
            if (baseUrl.Length == 0)
            {
                if (manual) UpdEvent("error", new Dictionary<string, object> {
                    { "message", "업데이트 위치가 설정되어 있지 않습니다. 도구 → 업데이트 설정에서 지정하세요." } });
                return;
            }
            try
            {
                string txt;
                if (IsHttp(baseUrl))
                {
                    using (var wc = new WebClient { Encoding = Encoding.UTF8 })
                        txt = wc.DownloadString(baseUrl.TrimEnd('/') + "/latest.json");
                }
                else txt = Store.ReadText(Path.Combine(baseUrl, "latest.json"));

                if (txt == null) throw new Exception("latest.json 을 읽지 못했습니다");
                var d = Store.JS.Deserialize<Dictionary<string, object>>(txt);
                object v, f;
                if (!d.TryGetValue("version", out v) || !d.TryGetValue("file", out f))
                    throw new Exception("latest.json 내용이 올바르지 않습니다");

                var ver = Convert.ToString(v);
                if (CmpVer(ver, Application.ProductVersion) > 0)
                {
                    pendingVersion = ver;
                    pendingFile = Convert.ToString(f);
                    object notes, date;
                    d.TryGetValue("notes", out notes);
                    d.TryGetValue("date", out date);
                    UpdEvent("available", new Dictionary<string, object> {
                        { "version", ver },
                        { "notes", notes == null ? "" : Convert.ToString(notes) },
                        { "date", date == null ? "" : Convert.ToString(date) }
                    });
                }
                else
                {
                    pendingVersion = null;
                    if (manual) UpdEvent("none", new Dictionary<string, object> { { "version", Application.ProductVersion } });
                }
            }
            catch (Exception ex)
            {
                if (manual) UpdEvent("error", new Dictionary<string, object> { { "message", ex.Message } });
            }
        }

        void ApplyUpdate()
        {
            if (pendingVersion == null || pendingFile == null) return;
            var baseUrl = (prefs.UpdateUrl ?? "").Trim();
            var dir = Path.Combine(Store.DataDir, "update");
            try
            {
                if (Directory.Exists(dir)) Directory.Delete(dir, true);
                Directory.CreateDirectory(dir);
                var dest = Path.Combine(dir, pendingFile);

                UpdEvent("progress", new Dictionary<string, object> { { "percent", 0 } });
                if (IsHttp(baseUrl))
                {
                    using (var wc = new WebClient())
                        wc.DownloadFile(baseUrl.TrimEnd('/') + "/" + Uri.EscapeDataString(pendingFile), dest);
                }
                else File.Copy(Path.Combine(baseUrl, pendingFile), dest, true);
                UpdEvent("progress", new Dictionary<string, object> { { "percent", 100 } });

                var target = Application.ExecutablePath;
                var bat = Path.Combine(dir, "apply-update.cmd");
                File.WriteAllText(bat, string.Join("\r\n", new[] {
                    "@echo off",
                    "title JJangditer Update",
                    "echo Updating...",
                    "set \"SRC=%~1\"",
                    "set \"DST=%~2\"",
                    "set /a n=0",
                    ":retry",
                    "set /a n+=1",
                    "copy /y \"%SRC%\" \"%DST%\" >nul 2>&1",
                    "if not errorlevel 1 goto ok",
                    "if %n% geq 40 goto fail",
                    "ping -n 2 127.0.0.1 >nul",
                    "goto retry",
                    ":ok",
                    "start \"\" \"%DST%\"",
                    "del \"%~f0\" >nul 2>&1",
                    "exit /b 0",
                    ":fail",
                    "echo.",
                    "echo Update failed - the program file is still in use.",
                    "echo   from: %SRC%",
                    "echo     to: %DST%",
                    "pause",
                    "exit /b 1"
                }), Encoding.ASCII);

                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
                {
                    FileName = "cmd.exe",
                    Arguments = "/c \"\"" + bat + "\" \"" + dest + "\" \"" + target + "\"\"",
                    UseShellExecute = true,
                    WindowStyle = System.Diagnostics.ProcessWindowStyle.Minimized
                });
                Quit();
            }
            catch (Exception ex)
            {
                UpdEvent("error", new Dictionary<string, object> { { "message", "업데이트 실패: " + ex.Message } });
            }
        }

        /* ---------------- 종료 ---------------- */

        void Quit()
        {
            quitting = true;
            try { Native.UnregisterHotKey(panel.Handle, HOTKEY_ID); } catch { }
            if (tray != null) { tray.Visible = false; tray.Dispose(); }
            if (trigger != null && !trigger.IsDisposed) trigger.Dispose();
            try { panel.Close(); } catch { }
            ExitThread();
        }
    }

    /* =========================== 시작 프로그램 등록 =========================== */

    static class Startup
    {
        const string KeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
        const string Name = "JJangditer";

        public static bool IsOn()
        {
            try
            {
                using (var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(KeyPath))
                    return k != null && k.GetValue(Name) != null;
            }
            catch { return false; }
        }

        public static bool Set(bool on)
        {
            try
            {
                using (var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(KeyPath, true))
                {
                    if (k == null) return false;
                    if (on) k.SetValue(Name, "\"" + Application.ExecutablePath + "\"");
                    else k.DeleteValue(Name, false);
                }
                return on;
            }
            catch { return false; }
        }
    }
}
