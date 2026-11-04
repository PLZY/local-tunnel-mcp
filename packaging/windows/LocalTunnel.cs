// Single-file Windows app: unpacks the embedded program on first run, starts it and stays in the tray.
// Compiled by build.ps1 with the csc.exe included in Windows, which accepts C# 5 only.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class Program {
  const string Title = "Local Tunnel";
  static string node, launcher;

  static string Resource(string name) {
    using (var reader = new StreamReader(Assembly.GetExecutingAssembly().GetManifestResourceStream(name))) return reader.ReadToEnd().Trim();
  }

  // Unpacks into a temporary folder first, so an interrupted run never leaves a partial version behind.
  static string Unpack() {
    var root = Path.Combine(Environment.GetEnvironmentVariable("LOCALAPPDATA"), "LocalTunnel");
    var version = Resource("version");
    var target = Path.Combine(root, version);
    if (File.Exists(Path.Combine(target, "runtime", "node.exe"))) return target;
    Directory.CreateDirectory(root);
    var partial = target + ".partial";
    if (Directory.Exists(partial)) Directory.Delete(partial, true);
    using (var zip = new ZipArchive(Assembly.GetExecutingAssembly().GetManifestResourceStream("app.zip"))) zip.ExtractToDirectory(partial);
    if (Directory.Exists(target)) Directory.Delete(target, true);
    Directory.Move(partial, target);
    foreach (var old in Directory.GetDirectories(root)) {
      if (old == target) continue;
      try { Directory.Delete(old, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }
    return target;
  }

  static string Run(string action) {
    var start = new ProcessStartInfo(node, "\"" + launcher + "\" " + action) {
      UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
      StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
    };
    using (var process = Process.Start(start)) {
      process.BeginOutputReadLine();
      var error = process.StandardError.ReadToEnd();
      process.WaitForExit();
      return process.ExitCode == 0 ? null : (error.Trim().Length > 0 ? error.Trim() : "启动失败，退出码 " + process.ExitCode);
    }
  }

  static void Fail(string message) {
    MessageBox.Show(message, Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
  }

  [STAThread]
  static void Main() {
    bool first;
    using (var mutex = new Mutex(true, @"Local\LocalTunnelApp", out first)) {
      Application.EnableVisualStyles();
      var tray = new NotifyIcon { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath), Text = Title, Visible = first };
      try {
        var directory = Unpack();
        node = Path.Combine(directory, "runtime", "node.exe");
        launcher = Path.Combine(directory, "src", "launcher.js");
        var error = Run("start");
        if (error != null) { Fail(error); return; }
        if (!first) return;

        var menu = new ContextMenuStrip();
        menu.Items.Add("打开控制台", null, (sender, e) => { var message = Run("start"); if (message != null) Fail(message); });
        menu.Items.Add("退出", null, (sender, e) => {
          var message = Run("stop");
          if (message != null) { Fail(message); return; }
          Application.Exit();
        });
        tray.ContextMenuStrip = menu;
        tray.DoubleClick += (sender, e) => { var message = Run("start"); if (message != null) Fail(message); };
        Application.Run();
      } catch (Exception problem) {
        Fail(problem.Message);
      } finally {
        tray.Dispose();
      }
    }
  }
}
