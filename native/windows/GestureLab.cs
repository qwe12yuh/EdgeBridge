// SPDX-License-Identifier: MIT
// Independent, explicitly enabled session-driven OLE lab; guarded source logical release only.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Threading;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[ComVisible(true), Guid("00000121-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ILabDropSource {
    [PreserveSig] int QueryContinueDrag([MarshalAs(UnmanagedType.Bool)] bool escape, uint keys);
    [PreserveSig] int GiveFeedback(uint effect);
}
[ComVisible(true), Guid("0000012B-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ILabDropSourceNotify {
    [PreserveSig] int DragEnterTarget(IntPtr hwnd);
    [PreserveSig] int DragLeaveTarget();
}
class GestureLab {
    const int Drop = 0x40100, Cancel = 0x40101, DefaultCursors = 0x40102;
    [DllImport("ole32.dll")] static extern int OleInitialize(IntPtr value);
    [DllImport("ole32.dll")] static extern void OleUninitialize();
    [DllImport("ole32.dll")] static extern int DoDragDrop([MarshalAs(UnmanagedType.Interface)] System.Runtime.InteropServices.ComTypes.IDataObject data,
        [MarshalAs(UnmanagedType.Interface)] ILabDropSource source, uint allowed, out uint effect);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wp, IntPtr lp);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hwnd,int index);
    [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr hwnd,int index,int value);
    [DllImport("user32.dll")] static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr marker);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr mode, uint flags, uint access, IntPtr security);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr handle,int index,StringBuilder text,int length,out int needed);
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup {
        public int cb; public string reserved,desktop,title;public int x,y,cx,cy,charsX,charsY,fill,flags;public short show,reservedCount;public IntPtr reservedData,input,output,error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {public IntPtr process,thread;public uint pid,tid;}
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref Startup start,out ProcessInfo info);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr handle,uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
    struct Point { public int x,y; }
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly object OutputGate = new object();
    static void Emit(object value) { lock(OutputGate) { Console.WriteLine(Json.Serialize(value)); Console.Out.Flush(); } }
    static long Now { get { return Stopwatch.GetTimestamp() * 1000 / Stopwatch.Frequency; } }
    class Session {
        public string id, reason;
        public long generation, seq, deadline, dropReleasedAt;
        public int lease;
        public string[] paths;
        public bool activated, running, released, dropReleased, cancelled, observed;
    }
    class Machine {
        public readonly object gate = new object();
        public Session session;
        readonly HashSet<string> seen = new HashSet<string>();
        public bool stopping;
        public static long Number(Dictionary<string,object> m, string key) {
            object v; if(!m.TryGetValue(key,out v) || !(v is int || v is long || v is decimal)) throw new ArgumentException("Expected integer " + key);
            decimal n=Convert.ToDecimal(v);
            if(n!=Decimal.Truncate(n) || n>9007199254740991m || n<0) throw new ArgumentException("Invalid integer " + key);
            return (long)n;
        }
        public string Accept(string line) {
            if(line.Length>65536) throw new ArgumentException("Command too large");
            Dictionary<string,object> m;
            lock(OutputGate) m=Json.Deserialize<Dictionary<string,object>>(line);
            if(m==null)throw new ArgumentException("Expected command object");
            string kind=m.ContainsKey("command") ? m["command"] as string : null;
            if(kind=="shutdown") { Stop("shutdown"); return kind; }
            string id=m.ContainsKey("id") ? m["id"] as string : null;
            Guid parsed; if(!Guid.TryParse(id,out parsed)) throw new ArgumentException("Invalid session ID");
            long generation=Number(m,"generation"), seq=Number(m,"seq");
            if(generation<1 || generation>UInt32.MaxValue || seq<1) throw new ArgumentException("Invalid generation/sequence");
            lock(gate) {
                if(stopping) throw new ArgumentException("Helper stopping");
                if(kind=="prepare") {
                    if(session!=null || sourceBusy || seen.Contains(id)) throw new ArgumentException("Busy or replayed session");
                    int lease=m.ContainsKey("leaseMs") ? checked((int)Number(m,"leaseMs")) : 2000;
                    if(lease<250 || lease>5000) throw new ArgumentException("Lease must be 250..5000 ms");
                    object raw; if(!m.TryGetValue("paths",out raw) || raw is string || !(raw is IEnumerable)) throw new ArgumentException("Expected paths");
                    var paths=new List<string>();
                    foreach(object item in (IEnumerable)raw) {
                        string p=item as string;
                        if(String.IsNullOrEmpty(p) || !Path.IsPathRooted(p) || (!File.Exists(p)&&!Directory.Exists(p))) throw new ArgumentException("Missing absolute fixture path");
                        paths.Add(Path.GetFullPath(p));
                    }
                    if(paths.Count<1 || paths.Count>1000) throw new ArgumentException("Invalid path count");
                    if(seen.Count>=4096) throw new ArgumentException("Restart helper before session history is full");
                    seen.Add(id);
                    session=new Session {id=id,generation=generation,seq=seq,lease=lease,deadline=Now+lease,paths=paths.ToArray()};
                    return kind;
                }
                var s=session;
                if(s==null || s.id!=id || s.generation!=generation || seq<=s.seq) throw new ArgumentException("Stale session/sequence");
                if(kind!="activate" && kind!="release" && kind!="cancel" && kind!="heartbeat") throw new ArgumentException("Unknown command");
                if(Now>s.deadline && !s.dropReleased) { s.cancelled=true; s.reason="lease-expired"; throw new ArgumentException("Expired session"); }
                if(kind=="activate" && (s.activated || s.released || s.cancelled)) throw new ArgumentException("Cannot activate completed gesture");
                s.seq=seq; s.deadline=Now+s.lease;
                if(kind=="activate") s.activated=true;
                if(kind=="release") { s.released=true; if(!s.running) {s.cancelled=true;s.reason="released-before-loop";} }
                if(kind=="cancel" && !s.dropReleased) {s.cancelled=true;s.reason="cancelled";}
                return kind;
            }
        }
        public void Stop(string reason) { lock(gate) {stopping=true;if(session!=null && !session.dropReleased){session.cancelled=true;session.reason=reason;}} }
        public void Expire() { lock(gate) { if(session!=null && !session.dropReleased && Now>session.deadline) { session.cancelled=true;session.reason="lease-expired"; } } }
    }
    // State-only candidate gate is exercised without creating windows or injecting input.
    class SourceState {
        public long generation,routeSeq,deadline,sourceSeq,blockedGeneration;
        public double observedUptimeMs;
        public string id,commitToken;
        public bool hit,committed;
        public static double ReadObservedTime(Dictionary<string,object> message) {
            object value;
            if(!message.TryGetValue("observedUptimeMs",out value) ||
               !(value is int || value is long || value is decimal || value is double || value is float))
                throw new ArgumentException("Expected numeric Mac observedUptimeMs");
            double time=Convert.ToDouble(value);
            if(Double.IsNaN(time)||Double.IsInfinity(time)||time<=0)
                throw new ArgumentException("Invalid Mac observedUptimeMs");
            return time;
        }
        public bool Candidate { get {return generation>0&&generation!=blockedGeneration&&Now<deadline;} }
        public void CandidateUpdate(long gen,long sequence,int lease) {
            if(gen<1||gen>UInt32.MaxValue||sequence<=routeSeq||lease<50||lease>500)throw new ArgumentException("Invalid/stale source candidate");
            if(gen!=generation){Clear();generation=gen;}
            routeSeq=sequence;deadline=Now+lease;
        }
        public void CandidateEnd(long gen,long sequence) {
            if(sequence<=routeSeq)throw new ArgumentException("Stale candidate end");
            routeSeq=sequence;
            if(gen==generation){deadline=0;Clear();}
        }
        public void Clear(){id=null;hit=false;committed=false;sourceSeq=0;commitToken=null;}
        public void Block(){blockedGeneration=generation;Clear();}
        public string Enter(){if(!Candidate||id!=null)throw new ArgumentException("Source candidate unavailable");id=Guid.NewGuid().ToString();hit=true;return id;}
        public void Check(string session,long gen,long sequence,bool commit) {
            if(id==null||id!=session||gen!=generation||sequence<=sourceSeq)throw new ArgumentException("Stale source session");
            if(commit&&(!Candidate||!hit||committed))throw new ArgumentException("Source context expired or left edge");
            sourceSeq=sequence;if(commit)committed=true;
        }
    }
    static volatile bool sourceBusy;
    class SourceEdge : Form {
        readonly SourceState state=new SourceState();
        readonly System.Windows.Forms.Timer watch=new System.Windows.Forms.Timer {Interval=20};
        string[] paths;
        bool accepted;
        protected override bool ShowWithoutActivation {get{return true;}}
        protected override CreateParams CreateParams {get{var p=base.CreateParams;p.ExStyle|=0x08000000|0x80|0x20;return p;}}
        void Pass(bool pass){int style=GetWindowLong(Handle,-20);SetWindowLong(Handle,-20,pass?style|0x20:style&~0x20);}
        bool Incoming {get{lock(machine.gate)return machine.session!=null||machine.stopping;}}
        bool Armed {get{return state.Candidate&&!Incoming&&!accepted;}}
        void Reset(string why,bool notify) {
            string id=state.id;long generation=state.generation;
            state.Block();paths=null;accepted=false;sourceBusy=false;Pass(true);
            if(notify&&id!=null)Emit(new {@event="source-left",id=id,generation=generation,reason=why});
        }
        public SourceEdge() {
            FormBorderStyle=FormBorderStyle.None;ShowInTaskbar=false;TopMost=true;
            StartPosition=FormStartPosition.Manual;BackColor=System.Drawing.Color.DodgerBlue;Opacity=0.04;AllowDrop=true;
            var screen=Screen.PrimaryScreen.Bounds;Bounds=new System.Drawing.Rectangle(screen.Left,screen.Top,12,screen.Height);
            DragEnter+=delegate(object sender,DragEventArgs e) {
                if(!Armed||state.id!=null||(e.AllowedEffect&DragDropEffects.Copy)==0||!e.Data.GetDataPresent(DataFormats.FileDrop)) {
                    e.Effect=DragDropEffects.None;Emit(new {@event="source-ignored",reason="unarmed-busy-or-no-copy-file-drop"});return;
                }
                var selected=e.Data.GetData(DataFormats.FileDrop) as string[];
                if(selected==null||selected.Length==0){e.Effect=DragDropEffects.None;return;}
                foreach(string p in selected)if(!Path.IsPathRooted(p)||(!File.Exists(p)&&!Directory.Exists(p))){e.Effect=DragDropEffects.None;return;}
                lock(machine.gate){if(machine.session!=null||machine.stopping){e.Effect=DragDropEffects.None;return;}state.Enter();sourceBusy=true;}
                paths=selected;e.Effect=DragDropEffects.Copy;
                Emit(new {@event="source-entered",id=state.id,generation=state.generation,routeSeq=state.routeSeq});
                Emit(new {@event="source-prepare",id=state.id,generation=state.generation,observedGeneration=state.generation,observedUptimeMs=state.observedUptimeMs,routeSeq=state.routeSeq,paths=paths});
            };
            DragOver+=delegate(object sender,DragEventArgs e){e.Effect=Armed&&state.hit&&state.id!=null?DragDropEffects.Copy:DragDropEffects.None;};
            DragLeave+=delegate {if(!accepted)Reset("left-edge",true);};
            DragDrop+=delegate(object sender,DragEventArgs e) {
                if(!Armed||!state.hit||!state.committed||state.id==null){e.Effect=DragDropEffects.None;Reset("uncommitted-drop",true);return;}
                e.Effect=DragDropEffects.Copy;accepted=true;
                string id=state.id,token=state.commitToken;long generation=state.generation,seq=state.sourceSeq;
                Pass(true);Hide();
                // Report only after the managed DragDrop callback has returned.
                BeginInvoke(new Action(delegate {
                    if(state.id!=id||state.generation!=generation)return;
                    Reset("accepted",false);
                    Emit(new {@event="source-accepted",id=id,generation=generation,sourceSeq=seq,commitToken=token});
                }));
            };
            watch.Tick+=delegate {
                if(!state.Candidate||Incoming){if(state.id!=null)Reset("candidate-expired-or-incoming",true);Pass(true);Hide();return;}
                if(!accepted){if(!Visible)Show();Pass(false);}
            };
            watch.Start();
        }
        public void HandleSource(Dictionary<string,object> m) {
            string command=m["command"] as string;
            long generation=Machine.Number(m,"generation");
            if(command=="candidate") {
                if(!m.ContainsKey("edge")||(string)m["edge"]!="left"||!m.ContainsKey("source")||!(m["source"] is string)||String.IsNullOrWhiteSpace((string)m["source"])||((string)m["source"]).Length>255)throw new ArgumentException("Expected Windows left-edge candidate");
                long routeSequence=Machine.Number(m,"routeSeq");
                int lease=checked((int)Machine.Number(m,"leaseMs"));
                long received=Machine.Number(m,"receivedAt");
                double observed=SourceState.ReadObservedTime(m);
                if(routeSequence<=state.routeSeq||generation<state.generation||lease<50||lease>500||Now-received>=lease)throw new ArgumentException("Stale candidate");
                if(generation!=state.generation&&state.id!=null)Reset("candidate-generation-changed",true);
                state.CandidateUpdate(generation,routeSequence,lease);
                state.deadline=received+lease;state.observedUptimeMs=observed;
                if(Armed){if(!Visible)Show();Pass(false);}return;
            }
            if(command=="candidate-ended") {
                long routeSequence=Machine.Number(m,"routeSeq");
                if(routeSequence<=state.routeSeq)throw new ArgumentException("Stale candidate end");
                bool same=generation==state.generation;
                if(same)Reset("candidate-ended",true);
                state.CandidateEnd(generation,routeSequence);if(same)Pass(true);return;
            }
            string id=m.ContainsKey("id")?m["id"] as string:null;
            long sequence=Machine.Number(m,"sourceSeq");
            if(command=="source-reset"){state.Check(id,generation,sequence,false);Reset("source-reset",true);return;}
            if(command!="source-commit")throw new ArgumentException("Unknown source command");
            Point at;GetCursorPos(out at);
            if(!Armed||!Bounds.Contains(at.x,at.y)||WindowFromPoint(at)!=Handle)throw new ArgumentException("Source edge is no longer the cursor target");
            string token=m.ContainsKey("commitToken")?m["commitToken"] as string:null;
            if(String.IsNullOrEmpty(token)||token.Length<16||token.Length>128)throw new ArgumentException("Invalid source commit token");
            foreach(char c in token)if(c<33||c>126)throw new ArgumentException("Invalid source commit token");
            state.Check(id,generation,sequence,true);state.commitToken=token;
            // Deliberately local Windows logical release. Physical authority remains the Mac router.
            // Only the live copy-only OLE edge context above is allowed to trigger this call.
            mouse_event(4,0,0,0,new UIntPtr(0x45424745));
        }
        protected override void Dispose(bool disposing){if(disposing){watch.Stop();watch.Dispose();}base.Dispose(disposing);}
    }
    [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
    class Source : ILabDropSource, ILabDropSourceNotify {
        readonly Machine machine; readonly Session s;
        uint lastEffect=UInt32.MaxValue;
        public Source(Machine m,Session session) {machine=m;s=session;}
        public int QueryContinueDrag(bool escape,uint keys) {
            lock(machine.gate) {
                if(!s.observed) {s.observed=true; Emit(new {@event="drag-loop-running",id=s.id,generation=s.generation,seq=s.seq});}
                if(escape && !s.cancelled && !s.dropReleased) {s.cancelled=true;s.reason="escape";}
                if(!s.dropReleased && Now>s.deadline) {s.cancelled=true;s.reason="lease-expired";}
                if(s.cancelled) return Cancel;
                if(s.released) {
                    if(!s.dropReleased) {
                        s.dropReleased=true;
                        s.dropReleasedAt=Now;
                        Emit(new {@event="drop-released",id=s.id,generation=s.generation,seq=s.seq});
                    }
                    return Drop;
                }
                return 0;
            }
        }
        public int GiveFeedback(uint effect) { if(effect!=lastEffect) { lastEffect=effect;Emit(new {@event="feedback",id=s.id,generation=s.generation,effect=effect}); }return DefaultCursors; }
        public int DragEnterTarget(IntPtr hwnd) { Emit(new {@event="target-entered",id=s.id,generation=s.generation,hwnd=hwnd.ToInt64().ToString()});return 0; }
        public int DragLeaveTarget() { Emit(new {@event="target-left",id=s.id,generation=s.generation});return 0; }
    }
    static Machine machine;
    static Control host;
    static IntPtr hostHandle;
    static long wakeStarted;
    static void Wake() {
        // Only this process's hidden HWND receives these queued messages. No SendInput/mouse_event.
        Point p; GetCursorPos(out p);
        PostMessage(hostHandle,0x200,IntPtr.Zero,new IntPtr(unchecked((p.y<<16)|(p.x&65535))));
        PostMessage(hostHandle,0x101,new IntPtr(0x87),IntPtr.Zero); // local F24 key-up wakes OLE's state check
    }
    static void EndWithoutLoop() {
        Session s;
        lock(machine.gate) {s=machine.session;if(s==null||s.running||(!s.cancelled&&!s.released))return;machine.session=null;}
        Emit(new {@event="ended",id=s.id,generation=s.generation,seq=s.seq,copied=false,accepted=false,error=s.reason});
    }
    static void Queue(Action action) {
        try {host.BeginInvoke(action);}catch(InvalidOperationException) { }
    }
    static int lastHresult;
    static long lastDuration;
    static void StartDrag() {
        Session s;
        lock(machine.gate) {s=machine.session;if(s==null||s.running||!s.activated||s.cancelled||s.released)return;s.running=true;}
        uint effect=0;int result=unchecked((int)0x80004005);long began=Now;
        try {
            var data=new DataObject(DataFormats.FileDrop,s.paths);
            result=DoDragDrop((System.Runtime.InteropServices.ComTypes.IDataObject)data,new Source(machine,s),1,out effect);
        } catch(Exception ex) {s.cancelled=true;s.reason=ex.Message;}
        finally {
            lock(machine.gate) { s.running=false;machine.session=null;wakeStarted=0; }
            lastHresult=result;lastDuration=Now-began;
            bool accepted=result==Drop && (effect&1)!=0 && !s.cancelled;
            Emit(new {@event="ended",id=s.id,generation=s.generation,seq=s.seq,copied=accepted,accepted=accepted,hresult=result,effect=effect,error=s.reason,durationMs=lastDuration});
            if(machine.stopping) Application.ExitThread();
        }
    }
    static string Command(string kind,string id,long seq,string file) {
        lock(OutputGate) return Json.Serialize(new {command=kind,id=id,generation=1,seq=seq,paths=new string[]{file},leaseMs=2000});
    }
    static int SelfTest() {
        var m=new Machine();string id=Guid.NewGuid().ToString(),file=Application.ExecutablePath;
        if(m.Accept(Command("prepare",id,1,file))!="prepare")return 1;
        try {m.Accept(Command("activate",id,1,file));return 2;}catch(ArgumentException){}
        try {m.Accept(Command("activate",Guid.NewGuid().ToString(),2,file));return 3;}catch(ArgumentException){}
        try {m.Accept(Command("activate",id,2,file).Replace("\"generation\":1", "\"generation\":2"));return 7;}catch(ArgumentException){}
        try {m.Accept(Command("activate",id,2,file).Replace("\"seq\":2", "\"seq\":2.5"));return 8;}catch(ArgumentException){}
        m.Accept(Command("release",id,2,file));
        try {m.Accept(Command("activate",id,3,file));return 4;}catch(ArgumentException){}
        m.Stop("stdin-eof");if(!m.session.cancelled)return 5;
        m=new Machine();id=Guid.NewGuid().ToString();m.Accept(Command("prepare",id,1,file));m.session.deadline=Now-1;m.Expire();if(!m.session.cancelled)return 6;
        m=new Machine();id=Guid.NewGuid().ToString();m.Accept(Command("prepare",id,1,file));m.session.running=true;
        var dropProbe=new Source(m,m.session);
        var originalOut=Console.Out;
        var capturedOut=new StringWriter();
        try {
            Console.SetOut(capturedOut);
            if(dropProbe.QueryContinueDrag(false,0)!=0 || !m.session.observed || m.session.dropReleased) return 9;
            m.Accept(Command("release",id,2,file));
            if(dropProbe.QueryContinueDrag(false,0)!=Drop || !m.session.dropReleased || m.session.dropReleasedAt<=0) return 12;
        } finally { Console.SetOut(originalOut); }
        string emitted=capturedOut.ToString();
        if(!emitted.Contains("\"event\":\"drag-loop-running\"") || !emitted.Contains("\"event\":\"drop-released\"")) return 13;
        m.session.deadline=Now-1;m.Expire();m.Accept(Command("cancel",id,3,file));m.Stop("shutdown");
        if(m.session.cancelled)return 14;
        // An explicit P/Invoke interface parameter can work even when OLE's later
        // QueryInterface cannot discover an internal interface. Test the actual CCW.
        var source=new Source(m,m.session);
        IntPtr unknown=Marshal.GetIUnknownForObject(source);
        try {
            foreach(Type type in new Type[]{typeof(ILabDropSource),typeof(ILabDropSourceNotify)}) {
                IntPtr pointer=IntPtr.Zero;Guid iid=type.GUID;
                try {
                    int hr=Marshal.QueryInterface(unknown,ref iid,out pointer);
                    if(hr!=0 || pointer==IntPtr.Zero) throw new InvalidOperationException(type.Name+" is not exposed by the COM callable wrapper: 0x"+hr.ToString("X8"));
                }finally {if(pointer!=IntPtr.Zero)Marshal.Release(pointer);}
            }
        }finally {Marshal.Release(unknown);}
        GC.KeepAlive(source);
        var candidate=new SourceState();candidate.CandidateUpdate(7,1,300);string sourceId=candidate.Enter();
        try{candidate.Check(sourceId,8,1,true);return 20;}catch(ArgumentException){}
        candidate.hit=false;try{candidate.Check(sourceId,7,1,true);return 21;}catch(ArgumentException){}
        candidate.hit=true;candidate.deadline=Now-1;try{candidate.Check(sourceId,7,1,true);return 22;}catch(ArgumentException){}
        candidate.CandidateUpdate(7,2,300);candidate.Check(sourceId,7,1,true);
        try{candidate.Check(sourceId,7,2,true);return 23;}catch(ArgumentException){}
        candidate.Clear();try{candidate.Check(sourceId,7,3,true);return 24;}catch(ArgumentException){}
        candidate.CandidateUpdate(8,3,300);candidate.CandidateEnd(7,4);if(!candidate.Candidate)return 25;
        candidate.Block();candidate.CandidateUpdate(8,5,300);if(candidate.Candidate)return 28;
        try{candidate.Enter();return 29;}catch(ArgumentException){}
        candidate.CandidateUpdate(9,6,300);if(!candidate.Candidate)return 30;
        var fractional=Json.Deserialize<Dictionary<string,object>>("{\"observedUptimeMs\":123456.789125}");
        candidate.observedUptimeMs=SourceState.ReadObservedTime(fractional);
        var echoed=Json.Deserialize<Dictionary<string,object>>(Json.Serialize(new {observedUptimeMs=candidate.observedUptimeMs}));
        if(SourceState.ReadObservedTime(echoed)!=123456.789125)return 26;
        foreach(object invalid in new object[]{"123456.789125",Double.NaN,Double.PositiveInfinity,0,-1,true}) {
            try{SourceState.ReadObservedTime(new Dictionary<string,object>{{"observedUptimeMs",invalid}});return 27;}catch(ArgumentException){}
        }
        Console.WriteLine("PASS Mac fractional uptime: numeric finite positive round-trip, reject string/NaN/infinity/nonpositive/bool");
        const string chinesePath="C:/临时/图像-测试.png";
        if(Console.OutputEncoding.CodePage!=65001||Console.InputEncoding.CodePage!=65001||
           Encoding.UTF8.GetString(Console.OutputEncoding.GetBytes(chinesePath))!=chinesePath)return 31;
        var unicodeEcho=Json.Deserialize<Dictionary<string,object>>(Encoding.UTF8.GetString(Console.OutputEncoding.GetBytes(Json.Serialize(new {path=chinesePath}))));
        if((string)unicodeEcho["path"]!=chinesePath)return 32;
        Console.WriteLine("PASS UTF-8 stdin/stdout and Chinese path JSON byte round-trip; blocked source generation requires new press");
        Console.WriteLine("PASS source gate: expiry, generation, leave, duplicate commit and late reset (no UI/input)");
        Console.WriteLine("PASS protocol + COM QI: sequence, UUID, generation, early release, EOF, lease, IDropSource, IDropSourceNotify (no UI/input)");return 0;
    }
    static int Run(bool privateTest,string mode) {
        machine=new Machine();
        int initialized=OleInitialize(IntPtr.Zero);if(initialized<0) Marshal.ThrowExceptionForHR(initialized);
        host=new Control();host.CreateControl();hostHandle=host.Handle;
        SourceEdge sourceEdge=privateTest?null:new SourceEdge();
        var watchdog=new System.Threading.Timer(delegate {
            machine.Expire();
            bool terminal,running,observed,cancelled,dropReleased,stoppingNow;
            long dropElapsed=0;
            lock(machine.gate) {
                stoppingNow=machine.stopping;
                terminal=machine.session!=null&&(machine.session.cancelled||machine.session.released);
                running=machine.session!=null&&machine.session.running;
                observed=machine.session!=null&&machine.session.observed;
                cancelled=machine.session!=null&&machine.session.cancelled;
                dropReleased=machine.session!=null&&machine.session.dropReleased;
                if(dropReleased) dropElapsed=Now-machine.session.dropReleasedAt;
            }
            if(running&&!observed)Wake();
            if(terminal&&!dropReleased) {
                Wake();
                if(running&&cancelled) {if(Interlocked.Read(ref wakeStarted)==0)Interlocked.Exchange(ref wakeStarted,Now);else if(Now-Interlocked.Read(ref wakeStarted)>1500){Emit(new {@event="hard-stop",error="OLE did not consume cancellation"});Environment.Exit(9);}}
                else if(!running) Queue(EndWithoutLoop);
            } else if(running&&dropReleased&&dropElapsed>(stoppingNow?5000:60000)) {
                Emit(new {@event="hard-stop",error="OLE target drop exceeded post-release safety bound"});
                Environment.Exit(9);
            }
            if(machine.stopping&&!running) Queue(Application.ExitThread);
        },null,25,25);
        if(privateTest) {
            string id=Guid.NewGuid().ToString(),file=Application.ExecutablePath;
            machine.Accept(Command("prepare",id,1,file));machine.Accept(Command("activate",id,2,file));
            var worker=new Thread(delegate() {Thread.Sleep(200);if(mode=="eof")machine.Stop("stdin-eof");else if(mode=="lease") {lock(machine.gate)machine.session.deadline=Now-1;}else machine.Accept(Command(mode,id,3,file));Wake();});worker.IsBackground=true;worker.Start();
            host.BeginInvoke(new Action(delegate {StartDrag();machine.Stop("self-test-complete");Application.ExitThread();}));
        } else {
            Emit(new {@event="ready",protocol=1,mode="gesture-lab"});
            var reader=new Thread(delegate() {
                string line;
                while((line=Console.ReadLine())!=null) {
                    try {
                        if(line.Length>65536)throw new ArgumentException("Command too large");
                        Dictionary<string,object> message;lock(OutputGate)message=Json.Deserialize<Dictionary<string,object>>(line);
                        string kind=message!=null&&message.ContainsKey("command")?message["command"] as string:null;
                        if(kind=="candidate"||kind=="candidate-ended"||kind=="source-commit"||kind=="source-reset") {
                            message["receivedAt"]=Now;
                            var captured=message;
                            Queue(delegate {try{sourceEdge.HandleSource(captured);}catch(Exception ex){Emit(new {@event="source-ignored",reason=ex.Message});}});
                            continue;
                        }
                        string command=machine.Accept(line);Session s;lock(machine.gate)s=machine.session;
                        if(command=="prepare")Emit(new {@event="prepared",id=s.id,generation=s.generation,seq=s.seq});
                        if(command=="activate")Queue(StartDrag);
                        Wake();
                    }catch(Exception ex){Emit(new {@event="rejected",error=ex.Message});}
                }
                machine.Stop("stdin-eof");Wake();
            });reader.IsBackground=true;reader.Start();
        }
        Application.Run();watchdog.Dispose();if(sourceEdge!=null)sourceEdge.Dispose();host.Dispose();OleUninitialize();
        if(privateTest) {
            bool good=lastDuration>=100&&lastDuration<1500&&(mode=="release" ? lastHresult==Drop : lastHresult==Cancel);
            Console.WriteLine((good?"PASS":"FAIL")+" private desktop stationary OLE "+mode+" hr="+lastHresult+" ms="+lastDuration);
            return good?0:10;
        }
        return 0;
    }
    [STAThread] static int Main(string[] args) {
        try {
            Console.OutputEncoding=new UTF8Encoding(false);
            Console.InputEncoding=new UTF8Encoding(false);
            if(args.Length==1&&args[0]=="--encoding-probe"){Emit(new {@event="encoding-probe",path="C:/临时/图像-测试.png"});return 0;}
            if(args.Length==1&&args[0]=="--self-test")return SelfTest();
            if(args.Length==1&&args[0]=="--stdio")return Run(false,"");
            if(args.Length==2&&args[0]=="--private-ole-test"&&(args[1]=="cancel"||args[1]=="release"||args[1]=="eof"||args[1]=="lease")) {
                string name="EdgeBridge-OLE-"+Guid.NewGuid().ToString();
                IntPtr desktop=CreateDesktop(name,IntPtr.Zero,IntPtr.Zero,0,0x1ff,IntPtr.Zero);
                if(desktop==IntPtr.Zero)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                var start=new Startup {cb=Marshal.SizeOf(typeof(Startup)),desktop=name,flags=0x100,input=GetStdHandle(-10),output=GetStdHandle(-11),error=GetStdHandle(-12)};
                ProcessInfo info;
                try {
                    if(!CreateProcess(Application.ExecutablePath,new StringBuilder("\""+Application.ExecutablePath+"\" --ole-case-internal "+args[1]),IntPtr.Zero,IntPtr.Zero,true,0,IntPtr.Zero,null,ref start,out info))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                    try {if(WaitForSingleObject(info.process,5000)!=0){TerminateProcess(info.process,11);return 11;}uint code;GetExitCodeProcess(info.process,out code);return (int)code;}
                    finally {CloseHandle(info.thread);CloseHandle(info.process);}
                }finally {CloseDesktop(desktop);}
            }
            if(args.Length==2&&args[0]=="--ole-case-internal") {
                var name=new StringBuilder(256);int needed;
                if(!GetUserObjectInformation(GetThreadDesktop(GetCurrentThreadId()),2,name,512,out needed)||!name.ToString().StartsWith("EdgeBridge-OLE-",StringComparison.Ordinal))throw new InvalidOperationException("OLE self-test requires an isolated desktop");
                return Run(true,args[1]);
            }
            Console.Error.WriteLine("Explicit mode required: --stdio | --self-test | --private-ole-test cancel/release/eof/lease");return 2;
        }catch(Exception ex){Console.Error.WriteLine(ex.ToString());return 1;}
    }
}
