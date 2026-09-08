// Test-only helper. Operates exclusively on disposable test fixture files.
using System;
using System.IO;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
internal static class StorageFixture {
    static int Main(string[] args) {
        try {
            string mode = args[0], path = args[1];
            if (mode == "lock") {
                using (var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read)) {
                    Console.WriteLine("ready"); Console.Out.Flush(); Console.ReadLine(); return 0;
                }
            }
            if (mode == "protect" || mode == "deny-write" || mode == "reset") {
                var acl = File.GetAccessControl(path);
                if (mode == "protect") acl.SetAccessRuleProtection(true, true);
                else {
                    var rule = new FileSystemAccessRule(WindowsIdentity.GetCurrent().User, FileSystemRights.WriteData, AccessControlType.Deny);
                    if (mode == "deny-write") acl.AddAccessRule(rule); else acl.RemoveAccessRuleSpecific(rule);
                }
                File.SetAccessControl(path, acl);
            } else if (mode != "snapshot") throw new Exception("INVALID_MODE");
            var security = new RawSecurityDescriptor(File.GetAccessControl(path, AccessControlSections.Owner | AccessControlSections.Group | AccessControlSections.Access).GetSecurityDescriptorBinaryForm(), 0);
            var bytes = new byte[security.DiscretionaryAcl.BinaryLength]; security.DiscretionaryAcl.GetBinaryForm(bytes, 0);
            string value = File.GetCreationTimeUtc(path).Ticks + "\n" + security.Owner + "\n" + security.Group + "\n"
                + (int)(security.ControlFlags & ~ControlFlags.DiscretionaryAclAutoInherited) + "\n" + Convert.ToBase64String(bytes);
            using (var hash = SHA256.Create()) Console.WriteLine(BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(value))).Replace("-", "").ToLowerInvariant());
            return 0;
        } catch { Console.Error.WriteLine("FIXTURE_FAILED"); return 1; }
    }
}
