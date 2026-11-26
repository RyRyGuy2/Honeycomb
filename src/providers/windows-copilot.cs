using System;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Automation;

// The helper only targets the signed-in desktop app's accessibility controls.
internal static class WindowsCopilot
{
    private static readonly Regex ThreadPath = new Regex(@"/chat/conversation/([a-f0-9-]{36})(?:/|$)", RegexOptions.IgnoreCase);
    private static string executable;

    [StructLayout(LayoutKind.Sequential)]
    private struct Input
    {
        public uint Type;
        public InputValue Value;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputValue
    {
        [FieldOffset(0)] public KeyboardInput Keyboard;
        // Include the mouse fields so INPUT has the correct size on both 32-bit and 64-bit Windows.
        [FieldOffset(0)] public MouseInput Mouse;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardInput
    {
        public ushort VirtualKey, ScanCode;
        public uint Flags, Time;
        public UIntPtr Extra;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput
    {
        public int X, Y;
        public uint Data, Flags, Time;
        public UIntPtr Extra;
    }

    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern uint SendInput(uint count, Input[] input, int size);

    private static void Write(string type, string value)
    {
        Console.WriteLine(type + "\t" + value);
        Console.Out.Flush();
    }

    private static AutomationElement Window()
    {
        foreach (var process in Process.GetProcessesByName("copilotapp"))
        {
            using (process)
            {
                try
                {
                    if (process.MainWindowHandle != IntPtr.Zero &&
                        String.Equals(process.MainModule.FileName, executable, StringComparison.OrdinalIgnoreCase))
                        return AutomationElement.FromHandle(process.MainWindowHandle);
                }
                catch (System.ComponentModel.Win32Exception) { }
                catch (InvalidOperationException) { }
            }
        }
        return null;
    }

    private static AutomationElement[] Find(AutomationElement root, AutomationProperty property, object value)
    {
        return root.FindAll(TreeScope.Descendants, new PropertyCondition(property, value, PropertyConditionFlags.IgnoreCase))
            .Cast<AutomationElement>().ToArray();
    }

    private static AutomationElement Document()
    {
        var window = Window();
        if (window == null) return null;
        var documents = window.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document));
        // The desktop shell and embedded chat both expose RootWebArea. The chat owns the conversation URL.
        return documents.Cast<AutomationElement>().LastOrDefault(element =>
            element.Current.AutomationId == "RootWebArea" && Composer(element) != null);
    }

    private static AutomationElement Composer(AutomationElement document)
    {
        return Find(document, AutomationElement.NameProperty, "Message Copilot")
            .SingleOrDefault(element => element.Current.ControlType == ControlType.Edit && element.Current.IsEnabled);
    }

    private static string ThreadId(AutomationElement document)
    {
        Uri url;
        var value = document.GetCurrentPropertyValue(ValuePattern.ValueProperty, true) as string;
        if (!Uri.TryCreate(value, UriKind.Absolute, out url)) return "";
        var match = ThreadPath.Match(url.AbsolutePath);
        return match.Success ? match.Groups[1].Value.ToLowerInvariant() : "";
    }

    private static AutomationElement WaitForDocument()
    {
        var activated = IntPtr.Zero;
        for (var attempt = 0; attempt < 30; attempt++)
        {
            try
            {
                var window = Window();
                if (window != null)
                {
                    var handle = new IntPtr(window.Current.NativeWindowHandle);
                    if (activated != handle)
                    {
                        BringForward(handle);
                        activated = handle;
                    }
                    var document = Document();
                    if (document != null) return document;
                }
            }
            catch (ElementNotAvailableException) { }
            Thread.Sleep(300);
        }
        return null;
    }

    private static AutomationElement[] CompletedReplies(AutomationElement document)
    {
        return Find(document, AutomationElement.NameProperty, "Copy Response")
            .Where(element => element.Current.ControlType == ControlType.Button && element.Current.IsEnabled).ToArray();
    }

    private static AutomationElement ReplyArticle(AutomationElement copy, AutomationElement document)
    {
        var walker = TreeWalker.RawViewWalker;
        for (var current = walker.GetParent(copy); current != null && !current.Equals(document); current = walker.GetParent(current))
            if (current.Current.Name.StartsWith("Copilot said:", StringComparison.OrdinalIgnoreCase)) return current;
        return null;
    }

    private static AutomationElement SendButton(AutomationElement document)
    {
        var buttons = new[] { "Send", "Send message", "Send prompt", "Submit message", "Submit prompt" }
            .SelectMany(name => Find(document, AutomationElement.NameProperty, name))
            .Where(element => element.Current.ControlType == ControlType.Button && element.Current.IsEnabled).ToArray();
        return buttons.Length == 1 ? buttons[0] : null;
    }

    private static bool Invoke(AutomationElement element)
    {
        object pattern;
        if (element == null || !element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) return false;
        ((InvokePattern)pattern).Invoke();
        return true;
    }

    private static bool BringForward(IntPtr handle)
    {
        const int restoreWindow = 9;
        if (IsIconic(handle)) ShowWindowAsync(handle, restoreWindow);
        if (GetForegroundWindow() != handle) SetForegroundWindow(handle);
        for (var attempt = 0; attempt < 6 && GetForegroundWindow() != handle; attempt++) Thread.Sleep(75);
        return GetForegroundWindow() == handle;
    }

    private static Input Key(ushort virtualKey, ushort scanCode, uint flags)
    {
        return new Input
        {
            Type = 1, Value = new InputValue
            {
                Keyboard = new KeyboardInput { VirtualKey = virtualKey, ScanCode = scanCode, Flags = flags }
            }
        };
    }

    private static bool SendKeys(IntPtr window, AutomationElement composer, Input[] keys)
    {
        if (GetForegroundWindow() != window || !composer.Current.HasKeyboardFocus) return false;
        return SendInput((uint)keys.Length, keys, Marshal.SizeOf(typeof(Input))) == keys.Length;
    }

    private static bool TypeDraft(AutomationElement composer, string prompt)
    {
        var window = Window();
        if (window == null) return false;
        var handle = new IntPtr(window.Current.NativeWindowHandle);
        if (!BringForward(handle)) return false;
        composer.SetFocus();
        for (var attempt = 0; attempt < 6 && !composer.Current.HasKeyboardFocus; attempt++) Thread.Sleep(75);
        var lines = Normalize(prompt).Split('\n');
        for (var index = 0; index < lines.Length; index++)
        {
            if (index > 0 && !SendKeys(handle, composer, new[] { Key(0x10, 0, 0), Key(0x0d, 0, 0), Key(0x0d, 0, 2), Key(0x10, 0, 2) })) return false;
            var keys = lines[index].SelectMany(ch => new[] { Key(0, ch, 4), Key(0, ch, 6) }).ToArray();
            if (keys.Length > 0 && !SendKeys(handle, composer, keys)) return false;
        }
        return true;
    }

    private static string ReplyText(AutomationElement document, AutomationElement article)
    {
        const string label = "Copilot said:";
        var fallback = article.Current.Name.Substring(label.Length).Trim();
        object pattern;
        try
        {
            if (document.TryGetCurrentPattern(TextPattern.Pattern, out pattern))
            {
                var range = ((TextPattern)pattern).RangeFromChild(article);
                var text = Normalize(range.GetText(1000000)).Replace("\ufffc", "").Trim();
                if (text.StartsWith(label, StringComparison.OrdinalIgnoreCase)) text = text.Substring(label.Length).Trim();
                // Some Copilot versions expose only the toolbar through the article's text range.
                var prefix = Regex.Replace(fallback, @"\s+", " ");
                prefix = prefix.Substring(0, Math.Min(prefix.Length, 80));
                if (prefix.Length != 0 && text.Contains("\n") &&
                    Regex.Replace(text, @"\s+", " ").StartsWith(prefix, StringComparison.Ordinal)) return text;
            }
        }
        catch (ArgumentException) { }
        catch (InvalidOperationException) { }
        return fallback;
    }

    private static string Normalize(string text)
    {
        return (text ?? "").Replace("\r\n", "\n");
    }

    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length != 1) return 1;
        executable = args[0];
        var expected = Console.ReadLine() ?? "";
        var prompt = Encoding.UTF8.GetString(Convert.FromBase64String(Console.ReadLine() ?? ""));
        try
        {
            if (Window() == null) Process.Start(executable);
            var document = WaitForDocument();
            if (document == null) return 1;
            var previousThread = ThreadId(document);
            if (expected.Length != 0 && previousThread != expected)
            {
                Write("WRONG_THREAD", "");
                return 1;
            }
            var copies = CompletedReplies(document);
            if (expected.Length == 0 && (previousThread.Length != 0 || copies.Length != 0))
            {
                var links = Find(document, AutomationElement.NameProperty, "New")
                    .Where(element => element.Current.ControlType == ControlType.Hyperlink).ToArray();
                if (links.Length != 1 || !Invoke(links[0])) return 1;
                document = null;
                for (var attempt = 0; attempt < 25; attempt++)
                {
                    Thread.Sleep(300);
                    var candidate = Document();
                    if (candidate != null && ThreadId(candidate) != previousThread && CompletedReplies(candidate).Length == 0)
                    {
                        document = candidate;
                        break;
                    }
                }
                if (document == null) return 1;
                copies = CompletedReplies(document);
            }

            var composer = Composer(document);
            object valuePattern;
            if (composer == null || !composer.TryGetCurrentPattern(ValuePattern.Pattern, out valuePattern)) return 1;
            var input = (ValuePattern)valuePattern;
            var existingDraft = Normalize(input.Current.Value).Trim();
            if (input.Current.IsReadOnly || (existingDraft.Length > 0 && existingDraft != Normalize(prompt))) return 1;
            var initialThread = ThreadId(document);
            if (existingDraft.Length == 0)
            {
                input.SetValue(prompt);
                if (String.IsNullOrWhiteSpace(input.Current.Value) && !TypeDraft(composer, prompt)) return 1;
            }
            InvokePattern send = null;
            var draft = "";
            for (var attempt = 0; attempt < 20; attempt++)
            {
                Thread.Sleep(150);
                if (ThreadId(document) != initialThread) return 1;
                draft = Normalize(input.Current.Value).Trim();
                if (draft != Normalize(prompt)) continue;
                var button = SendButton(document);
                object pattern;
                if (button != null && button.TryGetCurrentPattern(InvokePattern.Pattern, out pattern))
                {
                    send = (InvokePattern)pattern;
                    break;
                }
            }
            if (send == null)
            {
                if (draft == Normalize(prompt))
                {
                    input.SetValue("");
                    var window = Window();
                    if (window != null && Normalize(input.Current.Value).Trim() == Normalize(prompt))
                        SendKeys(new IntPtr(window.Current.NativeWindowHandle), composer,
                            new[] { Key(0x11, 0, 0), Key(0x41, 0, 0), Key(0x41, 0, 2), Key(0x11, 0, 2), Key(0x08, 0, 0), Key(0x08, 0, 2) });
                }
                return 1;
            }

            if (ThreadId(document) != initialThread || Normalize(input.Current.Value).Trim() != Normalize(prompt))
                return 1;
            Write("SUBMITTED", initialThread);
            send.Invoke();
            var timer = Stopwatch.StartNew();
            while (timer.Elapsed < TimeSpan.FromMinutes(4))
            {
                Thread.Sleep(650);
                try
                {
                    document = Document();
                    if (document == null) continue;
                    var currentThread = ThreadId(document);
                    if (currentThread.Length == 0) continue;
                    if (initialThread.Length == 0)
                    {
                        initialThread = currentThread;
                        Write("THREAD", initialThread);
                    }
                    if (currentThread != initialThread) return 1;
                    var replies = CompletedReplies(document);
                    if (replies.Length <= copies.Length) continue;
                    var article = ReplyArticle(replies.Last(), document);
                    if (article == null) continue;
                    var reply = ReplyText(document, article);
                    if (reply.Length == 0) continue;
                    Write("REPLY", Convert.ToBase64String(Encoding.UTF8.GetBytes(reply)));
                    return 0;
                }
                catch (ElementNotAvailableException) { }
            }
        }
        catch (ElementNotAvailableException) { }
        catch (InvalidOperationException) { }
        catch (System.ComponentModel.Win32Exception) { }
        return 1;
    }
}
