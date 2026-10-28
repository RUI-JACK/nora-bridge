// Runs the actual WinForms discovery/install handlers without showing a window.
// This is a local integration harness, never included in the distribution.
using System;
using System.IO;
using System.Drawing;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.Web.Script.Serialization;

static class SetupHarness {
    static readonly BindingFlags Fields=BindingFlags.Instance|BindingFlags.NonPublic;
    static T Field<T>(object form,string name){return (T)form.GetType().GetField(name,Fields).GetValue(form);}
    static void Wait(Task task,int seconds){
        DateTime limit=DateTime.UtcNow.AddSeconds(seconds);
        while(!task.IsCompleted){if(DateTime.UtcNow>limit)throw new TimeoutException("GUI handler timed out");Application.DoEvents();Thread.Sleep(20);}
        task.GetAwaiter().GetResult();
    }
    [STAThread] static int Main(string[] args){
        if(args.Length!=5)return 2;
        Directory.CreateDirectory(args[1]);
        Type program=null;Form form=null;
        try{
            Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
            Assembly assembly=Assembly.LoadFrom(Path.GetFullPath(args[0]));
            program=assembly.GetType("SetupProgram",true);
            string payload=(string)program.GetMethod("Unpack").Invoke(null,null);
            Type type=assembly.GetType("SetupForm",true);
            form=(Form)Activator.CreateInstance(type,new object[]{payload});
            // Off-screen Show runs the production Shown handler and enables
            // native child rendering; no desktop screenshot is captured.
            form.StartPosition=FormStartPosition.Manual;
            form.Location=new Point(-32000,-32000);form.ShowInTaskbar=false;
            form.Show();
            DateTime discoveryLimit=DateTime.UtcNow.AddSeconds(15);
            while(Field<ComboBox>(form,"peer").Items.Count==0||!Field<Button>(form,"refresh").Enabled){
                if(DateTime.UtcNow>discoveryLimit)throw new TimeoutException("Discovery timed out");
                Application.DoEvents();Thread.Sleep(20);
            }
            ComboBox peers=Field<ComboBox>(form,"peer");
            if(Field<Button>(form,"install").Enabled)throw new Exception("Agent must be explicitly selected");
            int selected=-1;
            for(int i=1;i<peers.Items.Count;i++){
                object peer=peers.Items[i];
                foreach(string name in new[]{"Id","Name","Ip"})if(Convert.ToString(peer.GetType().GetField(name).GetValue(peer))==args[4])selected=i;
            }
            if(selected<1)throw new Exception("Requested test peer not found: "+Field<Label>(form,"state").Text+"; choices="+peers.Items.Count);
            peers.SelectedIndex=selected;
            Field<TextBox>(form,"installDirectory").Text=Path.GetFullPath(args[2]);
            Field<NumericUpDown>(form,"port").Value=Int32.Parse(args[3]);
            if(!Field<Button>(form,"install").Enabled)throw new Exception("Selection did not enable installation");
            form.PerformLayout();
            using(var bitmap=new Bitmap(form.Width,form.Height)){form.DrawToBitmap(bitmap,new Rectangle(0,0,bitmap.Width,bitmap.Height));bitmap.Save(Path.Combine(args[1],"setup-before.png"));}
            Wait((Task)type.GetMethod("Install",Fields).Invoke(form,null),130);
            string state=Field<Label>(form,"state").Text;
            File.WriteAllText(Path.Combine(args[1],"setup-output.txt"),Field<TextBox>(form,"output").Text);
            if(!state.StartsWith("安装完成。"))throw new Exception(state);
            using(var bitmap=new Bitmap(form.Width,form.Height)){form.DrawToBitmap(bitmap,new Rectangle(0,0,bitmap.Width,bitmap.Height));bitmap.Save(Path.Combine(args[1],"setup-after.png"));}
            File.WriteAllText(Path.Combine(args[1],"setup-harness.json"),new JavaScriptSerializer().Serialize(new{passed=true,mode="offscreen_native_form_actual_handlers",explicit_peer_selection=true,backend="Windows PowerShell 5.1",state=state}));
            return 0;
        }catch(Exception e){File.WriteAllText(Path.Combine(args[1],"setup-harness.json"),new JavaScriptSerializer().Serialize(new{passed=false,error=e.ToString()}));return 1;}
        finally{if(form!=null)form.Dispose();if(program!=null)program.GetMethod("Cleanup").Invoke(null,null);}
    }
}
