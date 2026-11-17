// SPDX-License-Identifier: MIT
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

class NativeDrag
{
    static readonly object gate = new object();
    static readonly JavaScriptSerializer json = new JavaScriptSerializer();
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr window, int index);
    [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr window, int index, int value);
    [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
    static void Button(bool down) { mouse_event(down ? 2u : 4u, 0, 0, 0, new UIntPtr(0x45424745)); }
    static void Emit(object value) { lock (gate) { Console.WriteLine(json.Serialize(value)); Console.Out.Flush(); } }
    class Command
    {
        public string kind, id;
        public string[] paths;
    }
    static Command ParseCommand(string line)
    {
        if (line.Length > 65536) throw new ArgumentException("Command too large");
        var message = json.Deserialize<Dictionary<string, object>>(line);
        object value;
        var command = new Command { kind = message.ContainsKey("command") ? message["command"] as string : null,
            id = message.ContainsKey("id") ? message["id"] as string : null };
        if (command.kind == "shutdown") return command;
        Guid guid;
        if (!Guid.TryParse(command.id, out guid)) throw new ArgumentException("Expected session ID");
        if (command.kind == "cancel") return command;
        if (command.kind != "incoming") throw new ArgumentException("Unknown command");
        if (!message.TryGetValue("time", out value)) throw new ArgumentException("Expected timestamp");
        double age = (DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds - Convert.ToDouble(value);
        if (Double.IsNaN(age) || Double.IsInfinity(age) || age < -1000 || age > 10000) throw new ArgumentException("Expired incoming command");
        if (!message.TryGetValue("paths", out value)) throw new ArgumentException("Expected paths");
        var list = value as System.Collections.IEnumerable;
        if (list == null || value is string) throw new ArgumentException("Expected path array");
        var selected = new List<string>();
        foreach (object item in list) {
            if (!(item is string) || String.IsNullOrEmpty((string)item)) throw new ArgumentException("Expected string path");
            selected.Add((string)item);
        }
        if (selected.Count == 0 || selected.Count > 1000) throw new ArgumentException("Invalid path count");
        command.paths = selected.ToArray();
        return command;
    }
    static bool busy, cancelled;
    static string activeId;
    static void End(string id, bool copied, string error)
    { Emit(new { @event = "native-drag-ended", id = id, copied = copied, error = error }); }
    static void Receive(string[] paths, string id)
    {
        if (busy) { End(id, false, "Another native drag is active"); return; }
        foreach (string p in paths) if (!File.Exists(p) && !Directory.Exists(p)) { End(id, false, "Staged path missing"); return; }
        // Never manufacture a new button press after a slow transfer or an early release.
        if ((GetAsyncKeyState(1) & 0x8000) == 0) { End(id, false, "Mouse button released before native drag was ready"); return; }
        busy = true; cancelled = false; activeId = id;
        using (Form source = new Form { ShowInTaskbar = false })
        {
            IntPtr handle = source.Handle; // OLE needs a UI-thread window, not a hit-test overlay.
            DateTime deadline = DateTime.UtcNow.AddSeconds(60);
            source.QueryContinueDrag += delegate(object sender, QueryContinueDragEventArgs e) {
                if (cancelled || DateTime.UtcNow > deadline) e.Action = DragAction.Cancel;
            };
            try {
                Emit(new { @event = "native-drag-started", id = id });
                DragDropEffects effect = source.DoDragDrop(new DataObject(DataFormats.FileDrop, paths), DragDropEffects.Copy);
                End(id, !cancelled && effect == DragDropEffects.Copy, cancelled ? "Native drag cancelled" : null);
            } catch (Exception ex) { End(id, false, ex.Message); }
            finally { busy = false; activeId = null; }
        }
    }
    static void Dispatch(Command command, Form host)
    {
        if (command.kind == "cancel") { if (activeId == command.id) cancelled = true; }
        else if (command.kind == "shutdown") { cancelled = true; host.Close(); }
        else Receive(command.paths, command.id);
    }
    class Edge : Form
    {
        string[] pending;
        bool handing, down;
        Point origin;
        readonly System.Windows.Forms.Timer watch = new System.Windows.Forms.Timer { Interval = 25 };
        protected override bool ShowWithoutActivation { get { return true; } }
        protected override CreateParams CreateParams { get { var p = base.CreateParams; p.ExStyle |= 0x08000000 | 0x80 | 0x20; return p; } }
        void PassClicks(bool pass) { int style = GetWindowLong(Handle, -20); SetWindowLong(Handle, -20, pass ? style | 0x20 : style & ~0x20); }
        readonly System.Windows.Forms.Timer reset = new System.Windows.Forms.Timer { Interval = 1500 };
        public Edge(string side)
        {
            FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; TopMost = true;
            StartPosition = FormStartPosition.Manual; BackColor = Color.DodgerBlue; Opacity = 0.08; AllowDrop = true;
            Rectangle screen = Screen.PrimaryScreen.Bounds;
            Bounds = new Rectangle(side == "left" ? screen.Left : screen.Right - 12, screen.Top, 12, screen.Height);
            DragEnter += delegate(object sender, DragEventArgs e)
            {
                pending = null;
                if (busy || handing || !e.Data.GetDataPresent(DataFormats.FileDrop) || (e.AllowedEffect & DragDropEffects.Copy) == 0) { e.Effect = DragDropEffects.None; return; }
                pending = e.Data.GetData(DataFormats.FileDrop) as string[];
                e.Effect = (e.AllowedEffect & DragDropEffects.Copy) != 0 ? DragDropEffects.Copy : DragDropEffects.None;
            };
            DragOver += delegate(object sender, DragEventArgs e)
            {
                if (pending == null || busy) { e.Effect = DragDropEffects.None; return; }
                e.Effect = DragDropEffects.Copy;
                if (!handing)
                {
                    handing = true;
                    var release = new System.Windows.Forms.Timer { Interval = 30 };
                    // A missed DragDrop callback must not leave the strip armed forever.
                    reset.Start();
                    release.Tick += delegate { release.Stop(); release.Dispose(); if (handing) Button(false); };
                    release.Start();
                }
            };
            DragDrop += delegate
            {
                string[] paths = pending; pending = null;
                if (paths != null) Emit(new { @event = "outgoing", paths = paths });
                Hide(); reset.Start();
            };
            DragLeave += delegate { if (!handing) pending = null; };
            reset.Tick += delegate { reset.Stop(); handing = false; pending = null; PassClicks(true); Show(); };
            Shown += delegate { PassClicks(true); watch.Start(); };
            watch.Tick += delegate {
                bool held = (GetAsyncKeyState(1) & 0x8000) != 0;
                if (!held) { down = false; if (!handing) PassClicks(true); return; }
                if (!down) { origin = Cursor.Position; down = true; return; }
                if (busy || handing) return;
                Point at = Cursor.Position;
                if (Math.Abs(at.X - origin.X) + Math.Abs(at.Y - origin.Y) < 12) return;
                uint pid; GetWindowThreadProcessId(GetForegroundWindow(), out pid);
                try { if (System.Diagnostics.Process.GetProcessById((int)pid).ProcessName == "explorer") PassClicks(false); }
                catch { PassClicks(true); }
            };
            FormClosed += delegate { watch.Stop(); watch.Dispose(); reset.Dispose(); };
        }
    }
    [STAThread]
    static int Main(string[] args)
    {
        if (args.Length > 0 && args[0] == "--check")
        {
            if (args.Length < 2) return 1;
            for (int i = 1; i < args.Length; i++) if (!File.Exists(args[i]) && !Directory.Exists(args[i])) return 1;
            Console.WriteLine("Native paths valid: " + (args.Length - 1)); return 0;
        }
        Application.EnableVisualStyles();
        if (args.Length == 1 && args[0] == "--self-test")
        {
            string id = Guid.NewGuid().ToString();
            string valid = json.Serialize(new { command = "incoming", id = id, paths = new string[] { "C:/example.txt" },
                time = (DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds });
            Command parsed = ParseCommand(valid);
            if (parsed.paths.Length != 1 || parsed.paths[0] != "C:/example.txt") return 2;
            try { ParseCommand(valid.Replace("C:/example.txt", "")); return 4; } catch (ArgumentException) { }
            string expired = json.Serialize(new { command = "incoming", id = id, paths = new string[] { "x" }, time = 1 });
            try { ParseCommand(expired); return 5; } catch (ArgumentException) { }
            if (ParseCommand(json.Serialize(new { command = "cancel", id = id })).kind != "cancel") return 6;
            using (Edge probe = new Edge("left")) {
                if ((GetWindowLong(probe.Handle, -20) & 0x20) == 0) return 3;
            }
            if ((GetAsyncKeyState(1) & 0x8000) == 0) Receive(new string[] { Application.ExecutablePath }, id);
            else return 7; // self-test must never start a drag while a user holds the mouse
            if (busy) return 8;
            Console.WriteLine("PASS: JSON array, expiry, cancellation, idle click-through and released-button rejection"); return 0;
        }
        if (args.Length == 2 && args[0] == "--edge" && (args[1] == "left" || args[1] == "right"))
        {
            Edge edge = new Edge(args[1]);
            edge.Shown += delegate
            {
                Emit(new { @event = "edge-ready", side = args[1] });
                var reader = new Thread(delegate()
                {
                    string line;
                    while ((line = Console.ReadLine()) != null)
                    {
                        try {
                            Command command = ParseCommand(line);
                            edge.BeginInvoke(new Action(delegate { Dispatch(command, edge); }));
                        } catch (Exception ex) { Console.Error.WriteLine(ex.Message); }
                    }
                    edge.BeginInvoke(new Action(delegate { edge.Close(); }));
                });
                reader.IsBackground = true; reader.Start();
            };
            Application.Run(edge); return 0;
        }
        Form host = new Form { ShowInTaskbar = false, Opacity = 0 };
        host.Shown += delegate {
            host.Hide();
            // Manual CLI mode waits for an actual click; automatic mode never presses a button.
            Form tile = new Form { Text = "Drag these files", Size = new Size(240, 100), TopMost = true };
            tile.MouseDown += delegate(object sender, MouseEventArgs e) {
                if (e.Button == MouseButtons.Left) { Receive(args, Guid.NewGuid().ToString()); tile.Close(); host.Close(); }
            };
            tile.Show();
        };
        Application.Run(host); return 0;
    }
}
