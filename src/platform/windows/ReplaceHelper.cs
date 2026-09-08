// Windows-only, single-transaction helper. No shell, network, UI or general file API.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

internal static class ReplaceHelper
{
    const uint Read = 0x80000000, Write = 0x40000000, Delete = 0x10000, WriteDacl = 0x40000, Attributes = 0x80;
    const uint OpenExisting = 3, CreateNew = 1, Reparse = 0x00200000, Directory = 0x02000000;
    const long Epoch = 116444736000000000;
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 32768, RecursionLimit = 12 };
    static string token;
    static bool attempted, published;
    static readonly List<SafeFileHandle> directories = new List<SafeFileHandle>();

    [StructLayout(LayoutKind.Sequential)] struct Info {
        public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh, Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [StructLayout(LayoutKind.Sequential)] struct Basic {
        public long Creation, Access, Write, Change; public uint Attributes;
    }
    [StructLayout(LayoutKind.Sequential)] struct Disposition { [MarshalAs(UnmanagedType.Bool)] public bool Delete; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandle(SafeFileHandle file, out Info info);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int kind, out Basic info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int kind, IntPtr info, uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder path, uint size, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ReplaceFileW(string target, string replacement, string backup, uint flags, IntPtr exclude, IntPtr reserved);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetFileInformationByHandle(SafeFileHandle file, int kind, ref Disposition info, uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern uint GetDriveTypeW(string root);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetKernelObjectSecurity(SafeFileHandle file, uint information, byte[] security, uint length, out uint needed);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool SetFileSecurityW(string path, uint information, byte[] security);

    static string Extended(string path) { return "\\\\?\\" + path; }
    static string Text(object value) { if (!(value is string)) throw new Exception("NATIVE_INVALID_REQUEST"); return (string)value; }
    static Dictionary<string, object> Map(object value, int count) {
        var map = value as Dictionary<string, object>;
        if (map == null || map.Count != count) throw new Exception("NATIVE_INVALID_REQUEST"); return map;
    }
    static string Field(Dictionary<string, object> map, string key) { return Text(map[key]); }
    static Dictionary<string, object> Message() {
        var line = new StringBuilder(); int ch;
        while ((ch = Console.In.Read()) != -1 && ch != '\n') {
            if (line.Length >= 32768) throw new Exception("NATIVE_INVALID_REQUEST"); line.Append((char)ch);
        }
        if (line.Length == 0 && ch == -1) return null;
        return Json.DeserializeObject(line.ToString()) as Dictionary<string, object>;
    }
    static void Emit(string kind, object data) {
        Console.WriteLine(Json.Serialize(new { version = 1, token = token, kind = kind, data = data })); Console.Out.Flush();
    }
    static bool Command(string expected) {
        var message = Message();
        return message != null && message.Count == 3 && Convert.ToInt32(message["version"], CultureInfo.InvariantCulture) == 1
            && Field(message, "token") == token && Field(message, "command") == expected;
    }
    static SafeFileHandle Open(string path, uint access, uint share, bool directory, bool create) {
        var handle = CreateFileW(Extended(path), access, share, IntPtr.Zero, create ? CreateNew : OpenExisting,
            Reparse | (directory ? Directory : 0), IntPtr.Zero);
        if (handle.IsInvalid) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Exception("NATIVE_OPEN_" + error); }
        try {
            var info = Stat(handle);
            if ((info.Attributes & 0x400) != 0 || (directory != ((info.Attributes & 0x10) != 0)) || (!directory && info.Links != 1)) throw new Exception("NATIVE_FILE_CHANGED");
            return handle;
        } catch { handle.Dispose(); throw; }
    }
    static Info Stat(SafeFileHandle file) { Info info; if (!GetFileInformationByHandle(file, out info)) throw new Exception("NATIVE_STAT_FAILED"); return info; }
    static Basic Times(SafeFileHandle file) { Basic info; if (!GetFileInformationByHandleEx(file, 0, out info, (uint)Marshal.SizeOf(typeof(Basic)))) throw new Exception("NATIVE_STAT_FAILED"); return info; }
    static string Number(ulong value) { return value.ToString(CultureInfo.InvariantCulture); }
    static string Nano(long value) { return checked((value - Epoch) * 100).ToString(CultureInfo.InvariantCulture); }
    static string Id(Info info) { return Number(((ulong)info.IndexHigh << 32) | info.IndexLow); }
    static object Identity(SafeFileHandle file) { var info = Stat(file); var time = Times(file); return new { dev = Number(info.Volume), ino = Id(info), mtimeNs = Nano(time.Write), ctimeNs = Nano(time.Change) }; }
    static void Verify(SafeFileHandle file, Dictionary<string, object> expected, bool times) {
        var info = Stat(file);
        if (Number(info.Volume) != Field(expected, "dev") || Id(info) != Field(expected, "ino") || Id(info) == "0") throw new Exception("NATIVE_FILE_CHANGED");
        if (times) { var value = Times(file); if (Nano(value.Write) != Field(expected, "mtimeNs") || Nano(value.Change) != Field(expected, "ctimeNs")) throw new Exception("NATIVE_FILE_CHANGED"); }
    }
    static string FinalPath(SafeFileHandle file) {
        var path = new StringBuilder(32768); uint count = GetFinalPathNameByHandleW(file, path, 32768, 0);
        if (count == 0 || count >= 32768 || !path.ToString().StartsWith("\\\\?\\", StringComparison.Ordinal)) throw new Exception("NATIVE_PATH_FAILED");
        return path.ToString().Substring(4);
    }
    static string Hash(FileStream file) {
        if (file.Length > 5 * 1024 * 1024) throw new Exception("NATIVE_SIZE_LIMIT");
        file.Position = 0; using (var sha = SHA256.Create()) { return BitConverter.ToString(sha.ComputeHash(file)).Replace("-", "").ToLowerInvariant(); }
    }
    static RawSecurityDescriptor Security(SafeFileHandle file) {
        uint size; GetKernelObjectSecurity(file, 7, null, 0, out size);
        if (size == 0 || size > 65536) throw new Exception("NATIVE_SECURITY_FAILED");
        var bytes = new byte[size];
        if (!GetKernelObjectSecurity(file, 7, bytes, size, out size)) throw new Exception("NATIVE_SECURITY_FAILED");
        return new RawSecurityDescriptor(bytes, 0);
    }
    static string Metadata(SafeFileHandle file) {
        var security = Security(file); var acl = security.DiscretionaryAcl;
        byte[] bytes = acl == null ? new byte[0] : new byte[acl.BinaryLength]; if (acl != null) acl.GetBinaryForm(bytes, 0);
        // ReplaceFileW sets the informational auto-inherited marker. Compare the
        // actual ACE bytes, protection and all other returned control flags.
        return Times(file).Creation.ToString(CultureInfo.InvariantCulture) + ":" + (Stat(file).Attributes & (2u | 4u | 0x800u | 0x4000u)).ToString(CultureInfo.InvariantCulture)
            + "\n" + security.Owner + "\n" + security.Group + "\n"
            + ((int)(security.ControlFlags & ~ControlFlags.DiscretionaryAclAutoInherited)).ToString(CultureInfo.InvariantCulture)
            + "\n" + Convert.ToBase64String(bytes);
    }
    static void RestoreDacl(SafeFileHandle file, RawSecurityDescriptor original) {
        var bytes = new byte[original.BinaryLength]; original.GetBinaryForm(bytes, 0);
        // Legacy descriptor compatibility: SetSecurityInfo recalculates inherited
        // ACE flags. The result handle forbids rename/delete while this documented
        // file API restores the original descriptor, then Metadata verifies it.
        if (!SetFileSecurityW(Extended(FinalPath(file)), 4, bytes)) throw new Exception("NATIVE_ACL_RESTORE_FAILED");
    }
    static string Streams(SafeFileHandle file) {
        IntPtr data = Marshal.AllocHGlobal(65536);
        try {
            if (!GetFileInformationByHandleEx(file, 7, data, 65536)) throw new Exception("NATIVE_STREAMS_UNSUPPORTED");
            int offset = 0, count = 0; long total = 0; var fingerprints = new List<string>();
            while (true) {
                if (++count > 128 || offset < 0 || offset > 65512) throw new Exception("NATIVE_STREAMS_LIMIT");
                IntPtr current = IntPtr.Add(data, offset); int next = Marshal.ReadInt32(current), length = Marshal.ReadInt32(current, 4);
                long size = Marshal.ReadInt64(current, 8);
                if (length < 0 || length % 2 != 0 || length > 65512 - offset || size < 0) throw new Exception("NATIVE_STREAMS_INVALID");
                string name = Marshal.PtrToStringUni(IntPtr.Add(current, 24), length / 2);
                if (name != "::$DATA") {
                    total = checked(total + size);
                    if (total > 5 * 1024 * 1024 || name.Length < 8 || !name.StartsWith(":") || !name.EndsWith(":$DATA", StringComparison.Ordinal)
                        || Regex.IsMatch(name.Substring(1, name.Length - 7), "[\\x00-\\x1f\\x7f<>:\"|?*/\\\\]")) throw new Exception("NATIVE_STREAMS_LIMIT");
                    using (var streamHandle = Open(FinalPath(file) + name, Read, 5, false, false))
                    using (var stream = new FileStream(streamHandle, FileAccess.Read)) {
                        var primary = Stat(file); var secondary = Stat(streamHandle);
                        if (primary.Volume != secondary.Volume || Id(primary) != Id(secondary) || stream.Length != size) throw new Exception("NATIVE_STREAM_CHANGED");
                        fingerprints.Add(name + "\n" + Hash(stream));
                    }
                }
                if (next == 0) break;
                if (next < 24 + length || next % 8 != 0 || next > 65512 - offset) throw new Exception("NATIVE_STREAMS_INVALID"); offset += next;
            }
            fingerprints.Sort(StringComparer.Ordinal); return String.Join("\n", fingerprints.ToArray());
        } finally { Marshal.FreeHGlobal(data); }
    }
    static void LockDirectories(string parent, object expected) {
        var chain = expected as object[]; if (chain == null || chain.Length == 0 || chain.Length > 256) throw new Exception("NATIVE_INVALID_REQUEST");
        var paths = new List<string>(); string current = parent;
        while (current.Length > 3) { paths.Add(current); int slash = current.LastIndexOf('\\'); current = slash == 2 ? current.Substring(0, 3) : current.Substring(0, slash); }
        paths.Add(current); paths.Reverse();
        if (paths.Count != chain.Length || GetDriveTypeW(paths[0]) != 3) throw new Exception("NATIVE_LOCATION_UNSUPPORTED");
        for (int i = 0; i < paths.Count; i++) {
            var file = Open(paths[i], Attributes, i == 0 ? 7u : 3u, true, false); directories.Add(file); Verify(file, Map(chain[i], 2), false);
            if (!String.Equals(FinalPath(file).TrimEnd('\\'), paths[i].TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) throw new Exception("NATIVE_LOCATION_CHANGED");
        }
    }
    static void Run() {
        var request = Message(); Map(request, 8);
        if (Convert.ToInt32(request["version"], CultureInfo.InvariantCulture) != 1) throw new Exception("NATIVE_INVALID_REQUEST");
        token = Field(request, "transactionId"); if (!Regex.IsMatch(token, "^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$")) throw new Exception("NATIVE_INVALID_REQUEST");
        string path = Field(request, "path"), oldHash = Field(request, "oldHash"), newHash = Field(request, "newHash");
        if (path.Length > 1024 || !Regex.IsMatch(path, "^[A-Za-z]:\\\\") || Regex.IsMatch(path.Substring(3), "[\\x00-\\x1f<>:\"|?*/%~]")
            || !Regex.IsMatch(path, "\\.html?$", RegexOptions.IgnoreCase)) throw new Exception("NATIVE_INVALID_REQUEST");
        foreach (string part in path.Substring(3).Split('\\')) if (part.Length == 0 || part == "." || part == ".." || part.EndsWith(".") || part.EndsWith(" ")) throw new Exception("NATIVE_INVALID_REQUEST");
        if (!Regex.IsMatch(oldHash, "^[a-f0-9]{64}$") || !Regex.IsMatch(newHash, "^[a-f0-9]{64}$") || oldHash == newHash) throw new Exception("NATIVE_INVALID_REQUEST");
        int split = path.LastIndexOf('\\'); string parent = split == 2 ? path.Substring(0, 3) : path.Substring(0, split);
        string prefix = parent.TrimEnd('\\') + "\\.hae-" + token;
        string temp = prefix + ".tmp", backup = prefix + ".backup";
        LockDirectories(parent, request["directories"]);
        var oldExpected = Map(request["source"], 4); var tempExpected = Map(request["temp"], 4);
        // Require source write permission too: parent DELETE_CHILD alone must not
        // let an editor replace a source whose own ACL denies writing.
        using (var oldHandle = Open(path, Read | Write | Delete | WriteDacl, 5, false, false))
        using (var oldFile = new FileStream(oldHandle, FileAccess.Read)) {
            Verify(oldHandle, oldExpected, true);
            if ((Stat(oldHandle).Attributes & (1u | 0x1000u | 0x40000u | 0x400000u)) != 0 || Hash(oldFile) != oldHash) throw new Exception("NATIVE_FILE_CHANGED");
            string metadata = Metadata(oldHandle), streams = Streams(oldHandle); var oldSecurity = Security(oldHandle);
            using (var tempHandle = Open(temp, Read | Write, 0, false, false))
            using (var tempFile = new FileStream(tempHandle, FileAccess.ReadWrite)) {
                Verify(tempHandle, tempExpected, true);
                if (Hash(tempFile) != newHash) throw new Exception("NATIVE_TEMP_CHANGED"); tempFile.Flush(true);
                var nextSecurity = Security(tempHandle);
                if (!oldSecurity.Owner.Equals(nextSecurity.Owner) || !oldSecurity.Group.Equals(nextSecurity.Group)) throw new Exception("NATIVE_OWNER_UNSUPPORTED");
                if (Streams(tempHandle).Length != 0) throw new Exception("NATIVE_TEMP_STREAMS");
            }
            // CREATE_NEW reserves this generated backup name; existing files are never accepted.
            Info reservationIdentity;
            using (var reservation = Open(backup, Read | Write | Delete, 0, false, true))
            using (var reserved = new FileStream(reservation, FileAccess.ReadWrite)) { reserved.Flush(true); reservationIdentity = Stat(reservation); }
            Emit("ready", new { });
            if (!Command("replace")) { Emit("aborted", new { code = "SAVE_CANCELLED" }); return; }
            Verify(oldHandle, oldExpected, true);
            if (Hash(oldFile) != oldHash || Metadata(oldHandle) != metadata || Streams(oldHandle) != streams) throw new Exception("NATIVE_FILE_CHANGED");
            if (!String.Equals(FinalPath(oldHandle), path, StringComparison.OrdinalIgnoreCase)) throw new Exception("NATIVE_FILE_CHANGED");
            using (var check = Open(path, Read, 7, false, false)) { Verify(check, oldExpected, true); }
            using (var check = Open(temp, Read, 1, false, false))
            using (var candidate = new FileStream(check, FileAccess.Read)) {
                Verify(check, tempExpected, true); if (Hash(candidate) != newHash || Streams(check).Length != 0) throw new Exception("NATIVE_TEMP_CHANGED");
            }
            using (var check = Open(backup, Read, 1, false, false)) {
                var actual = Stat(check);
                if (actual.Volume != reservationIdentity.Volume || Id(actual) != Id(reservationIdentity) || actual.SizeHigh != 0 || actual.SizeLow != 0) throw new Exception("NATIVE_BACKUP_CHANGED");
            }
            attempted = true;
            if (!ReplaceFileW(Extended(path), Extended(temp), Extended(backup), 0, IntPtr.Zero, IntPtr.Zero)) throw new Exception("NATIVE_REPLACE_" + Marshal.GetLastWin32Error());
            using (var resultHandle = Open(path, Read | WriteDacl, 1, false, false))
            using (var resultFile = new FileStream(resultHandle, FileAccess.Read)) {
                Verify(resultHandle, tempExpected, false);
                if (!String.Equals(FinalPath(oldHandle), backup, StringComparison.OrdinalIgnoreCase)) throw new Exception("NATIVE_BACKUP_PATH_CHANGED");
                if (Hash(oldFile) != oldHash) throw new Exception("NATIVE_BACKUP_CHANGED");
                if (Hash(resultFile) != newHash) throw new Exception("NATIVE_RESULT_CHANGED");
                if (Metadata(resultHandle) != metadata) RestoreDacl(resultHandle, oldSecurity);
                if (Metadata(resultHandle) != metadata) throw new Exception("NATIVE_METADATA_CHANGED");
                if (Streams(resultHandle) != streams) throw new Exception("NATIVE_RESULT_STREAM_CHANGED");
                if (Streams(oldHandle) != streams) throw new Exception("NATIVE_BACKUP_STREAM_CHANGED");
                Emit("replaced", new { identity = Identity(resultHandle), resultHash = newHash });
                if (!Command("commit")) { Emit("retained", new { code = "SAVE_OUTCOME_UNKNOWN" }); return; }
                published = true;
                bool cleanupPending = true;
                if (Hash(resultFile) == newHash && Hash(oldFile) == oldHash && String.Equals(FinalPath(oldHandle), backup, StringComparison.OrdinalIgnoreCase)) {
                    var disposition = new Disposition { Delete = true };
                    cleanupPending = !SetFileInformationByHandle(oldHandle, 4, ref disposition, (uint)Marshal.SizeOf(typeof(Disposition)));
                }
                Emit("done", new { cleanupPending = cleanupPending });
            }
        }
    }
    static int Main() {
        Console.InputEncoding = new UTF8Encoding(false, true); Console.OutputEncoding = new UTF8Encoding(false);
        try { Run(); return 0; }
        catch (Exception error) {
            try { Emit(published ? "done" : attempted ? "unknown" : "failed", new { code = Regex.IsMatch(error.Message, "^[A-Z_0-9]+$") ? error.Message : "NATIVE_FAILED", cleanupPending = true }); } catch { }
            return 1;
        } finally { foreach (var file in directories) file.Dispose(); }
    }
}
