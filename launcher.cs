using System;
using System.IO;
using System.IO.Compression;
using System.Diagnostics;
class Launcher {
 static int Main(string[] args) {
  string dir=Path.Combine(Path.GetTempPath(),"ResticPackage-"+Guid.NewGuid().ToString("N"));
  try {
   using(var f=File.OpenRead(System.Reflection.Assembly.GetExecutingAssembly().Location)) {
    f.Seek(-8,SeekOrigin.End); byte[] n=new byte[8]; if(f.Read(n,0,8)!=8) throw new Exception("Missing payload"); long len=BitConverter.ToInt64(n,0); if(len<=0 || len>f.Length-8 || len>200000000) throw new Exception("Invalid payload");
    f.Position=f.Length-8-len; byte[] b=new byte[(int)len]; int p=0,r; while(p<b.Length && (r=f.Read(b,p,b.Length-p))>0) p+=r; if(p!=b.Length) throw new Exception("Truncated payload");
    Directory.CreateDirectory(dir); using(var z=new ZipArchive(new MemoryStream(b),ZipArchiveMode.Read)) foreach(var e in z.Entries) { string dest=Path.GetFullPath(Path.Combine(dir,e.FullName)); if(!dest.StartsWith(Path.GetFullPath(dir)+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase)) throw new Exception("Invalid path"); e.ExtractToFile(dest); }
   }
   string action=args.Length==0?"initialize":args[0]; if(action!="initialize" && action!="test" && action!="backup" && action!="help") throw new Exception("Invalid action");
   var info=new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),@"System32\WindowsPowerShell\v1.0\powershell.exe"),"-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \""+Path.Combine(dir,"restic-manager.ps1")+"\" -Action "+action); info.UseShellExecute=false; info.WorkingDirectory=dir; using(var proc=Process.Start(info)){proc.WaitForExit(); return proc.ExitCode;}
  } catch(Exception ex) { Console.Error.WriteLine(ex.Message); return 1; } finally { try{Directory.Delete(dir,true);}catch{} }
 }
}
