using System.Collections.ObjectModel;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows.Input;
using System.Windows.Threading;
using EthernetPacketGenerator.Commands;
using EthernetPacketGenerator.Models;

namespace EthernetPacketGenerator.ViewModels;

/// <summary>
/// Represents a single interface item returned by the peer probe.
/// </summary>
public sealed class RemoteInterfaceItem : ViewModelBase
{
    private bool _isSelected;

    public string Key         { get; init; } = "";
    public string Name        { get; init; } = "";
    public string Mac         { get; init; } = "";
    public string State       { get; init; } = "";
    public string Description { get; init; } = "";

    public bool IsSelected
    {
        get => _isSelected;
        set => SetProperty(ref _isSelected, value);
    }

    public string DisplayName => string.IsNullOrWhiteSpace(Description)
        ? Name
        : $"{Name}  —  {Description}";
}

/// <summary>
/// Remote-capture row shown in the DataGrid.
/// Populated from peer's /api/capture/packets response.
/// </summary>
public sealed class RemoteCaptureRow
{
    public int    No            { get; init; }
    public string Time          { get; init; } = "";
    public string InterfaceName { get; init; } = "";
    public string SrcMac        { get; init; } = "";
    public string DstMac        { get; init; } = "";
    public string Source        { get; init; } = "";
    public string Destination   { get; init; } = "";
    public string Protocol      { get; init; } = "";
    public int    Length        { get; init; }
    public string Info          { get; init; } = "";
    public string DetailJson    { get; init; } = "";
    public bool   IsMatch       { get; set; }   // matches target address
}

/// <summary>
/// ViewModel for the "Capture Address" tab.
/// Probes a remote peer's interfaces, starts/stops capture there,
/// polls packets through the Node.js proxy, and evaluates PASS/FAIL.
/// </summary>
public sealed class NdjsonBridgeViewModel : ViewModelBase, IDisposable
{
    // ── HTTP client (shared, long-lived) ──────────────────────────────────────
    private static readonly HttpClient _http = new HttpClient
    {
        Timeout = TimeSpan.FromSeconds(10)
    };

    // ── State ─────────────────────────────────────────────────────────────────
    private string            _peerUrl        = "http://localhost:8080";
    private string            _proxyBase      = "http://localhost:8080"; // local Node.js server
    private string            _status         = "Enter peer URL and press Probe.";
    private string            _targetAddress  = "";
    private string            _resultText     = "";
    private bool              _isCapturing    = false;
    private int               _lastOffset     = 0;
    private RemoteCaptureRow? _selectedPacket = null;

    private DispatcherTimer? _pollTimer;

    // ── Public bindable properties ────────────────────────────────────────────
    public string PeerUrl
    {
        get => _peerUrl;
        set => SetProperty(ref _peerUrl, value);
    }

    public string Status
    {
        get => _status;
        private set => SetProperty(ref _status, value);
    }

    public string TargetAddress
    {
        get => _targetAddress;
        set => SetProperty(ref _targetAddress, value);
    }

    public string ResultText
    {
        get => _resultText;
        private set => SetProperty(ref _resultText, value);
    }

    public bool IsCapturing
    {
        get => _isCapturing;
        private set
        {
            SetProperty(ref _isCapturing, value);
            System.Windows.Application.Current?.Dispatcher.InvokeAsync(
                System.Windows.Input.CommandManager.InvalidateRequerySuggested,
                DispatcherPriority.Background);
        }
    }

    public RemoteCaptureRow? SelectedPacket
    {
        get => _selectedPacket;
        set
        {
            if (SetProperty(ref _selectedPacket, value))
                OnPropertyChanged(nameof(SelectedDetailText));
        }
    }

    public string SelectedDetailText =>
        _selectedPacket?.DetailJson ?? "Select a packet row to inspect decoded fields.";

    // ── Collections ───────────────────────────────────────────────────────────
    public ObservableCollection<RemoteInterfaceItem> PeerInterfaces { get; } = new();
    public ObservableCollection<RemoteCaptureRow>    Packets        { get; } = new();

    // ── Commands ──────────────────────────────────────────────────────────────
    public ICommand ProbeCommand   { get; }
    public ICommand StartCommand   { get; }
    public ICommand StopCommand    { get; }
    public ICommand ClearCommand   { get; }
    public ICommand CheckCommand   { get; }

    // ── Constructor ───────────────────────────────────────────────────────────
    public NdjsonBridgeViewModel()
    {
        // Determine the local proxy base (Node.js server).
        // Defaults to localhost:8080 — same as peerUrl initial value.
        _proxyBase = "http://localhost:8080";

        ProbeCommand = new RelayCommand(
            async () => await ProbeAsync(),
            () => !IsCapturing);

        StartCommand = new RelayCommand(
            async () => await StartCaptureAsync(),
            () => !IsCapturing && PeerInterfaces.Any(i => i.IsSelected));

        StopCommand = new RelayCommand(
            async () => await StopCaptureAsync(),
            () => IsCapturing);

        ClearCommand = new RelayCommand(
            async () => await ClearAsync());

        CheckCommand = new RelayCommand(Evaluate);
    }

    // ── Probe ─────────────────────────────────────────────────────────────────
    private async Task ProbeAsync()
    {
        Status = "Probing peer…";
        PeerInterfaces.Clear();

        try
        {
            var body    = JsonSerializer.Serialize(new { peerUrl = PeerUrl });
            var content = new StringContent(body, Encoding.UTF8, "application/json");
            var resp    = await _http.PostAsync($"{_proxyBase}/api/remote-capture/probe", content);
            var json    = await resp.Content.ReadAsStringAsync();
            var doc     = JsonDocument.Parse(json);
            var root    = doc.RootElement;

            if (!root.TryGetProperty("ok", out var okProp) || !okProp.GetBoolean())
            {
                Status = $"Probe failed: {root.GetProperty("error").GetString()}";
                return;
            }

            if (root.TryGetProperty("interfaces", out var ifaces))
            {
                foreach (var iface in ifaces.EnumerateArray())
                {
                    PeerInterfaces.Add(new RemoteInterfaceItem
                    {
                        Key         = iface.TryGetProperty("key",  out var k) ? k.GetString() ?? "" : "",
                        Name        = iface.TryGetProperty("name", out var n) ? n.GetString() ?? "" : "",
                        Mac         = iface.TryGetProperty("mac",  out var m) ? m.GetString() ?? "" : "",
                        State       = iface.TryGetProperty("state",out var s) ? s.GetString() ?? "" : "",
                        Description = iface.TryGetProperty("description", out var d) ? d.GetString() ?? "" : "",
                        IsSelected  = false
                    });
                }
                // Auto-select first
                if (PeerInterfaces.Count > 0)
                    PeerInterfaces[0].IsSelected = true;
            }

            Status = $"Probe OK — {PeerInterfaces.Count} NIC(s) found on {PeerUrl}";
            System.Windows.Input.CommandManager.InvalidateRequerySuggested();
        }
        catch (Exception ex)
        {
            Status = $"Probe error: {ex.Message}";
        }
    }

    // ── Start capture ─────────────────────────────────────────────────────────
    private async Task StartCaptureAsync()
    {
        var selected = PeerInterfaces.Where(i => i.IsSelected).Select(i => i.Key).ToArray();
        if (selected.Length == 0)
        {
            Status = "Select at least one interface.";
            return;
        }

        // Reset local state
        Packets.Clear();
        _lastOffset   = 0;
        ResultText    = "";
        TargetAddress = "";

        try
        {
            var body    = JsonSerializer.Serialize(new { peerUrl = PeerUrl, interfaces = selected });
            var content = new StringContent(body, Encoding.UTF8, "application/json");
            var resp    = await _http.PostAsync($"{_proxyBase}/api/remote-capture/start", content);
            var json    = await resp.Content.ReadAsStringAsync();
            var doc     = JsonDocument.Parse(json);

            if (!doc.RootElement.TryGetProperty("ok", out var ok) || !ok.GetBoolean())
            {
                Status = "Start failed: " + (doc.RootElement.TryGetProperty("error", out var e) ? e.GetString() : "unknown");
                return;
            }

            IsCapturing = true;
            Status = $"Capturing from {PeerUrl} on [{string.Join(", ", selected)}]…";

            // Poll every 500 ms
            _pollTimer = new DispatcherTimer(DispatcherPriority.Background)
            {
                Interval = TimeSpan.FromMilliseconds(500)
            };
            _pollTimer.Tick += async (_, _) => await PollAsync();
            _pollTimer.Start();
        }
        catch (Exception ex)
        {
            Status = $"Start error: {ex.Message}";
        }
    }

    // ── Stop capture ──────────────────────────────────────────────────────────
    private async Task StopCaptureAsync()
    {
        _pollTimer?.Stop();
        _pollTimer = null;
        IsCapturing = false;

        try
        {
            var body    = JsonSerializer.Serialize(new { peerUrl = PeerUrl });
            var content = new StringContent(body, Encoding.UTF8, "application/json");
            await _http.PostAsync($"{_proxyBase}/api/remote-capture/stop", content);
        }
        catch { /* ignore */ }

        // One final poll
        await PollAsync();
        Status = $"Stopped. {Packets.Count} packet(s) captured.";
    }

    // ── Clear ─────────────────────────────────────────────────────────────────
    private async Task ClearAsync()
    {
        if (IsCapturing) await StopCaptureAsync();

        Packets.Clear();
        _lastOffset   = 0;
        ResultText    = "";
        TargetAddress = "";

        try
        {
            var body    = JsonSerializer.Serialize(new { peerUrl = PeerUrl });
            var content = new StringContent(body, Encoding.UTF8, "application/json");
            await _http.PostAsync($"{_proxyBase}/api/remote-capture/clear", content);
        }
        catch { /* ignore */ }

        Status = "Cleared.";
    }

    // ── Poll for new packets ──────────────────────────────────────────────────
    private async Task PollAsync()
    {
        try
        {
            var url  = $"{_proxyBase}/api/remote-capture/packets?peerUrl={Uri.EscapeDataString(PeerUrl)}&limit=500&offset={_lastOffset}";
            var resp = await _http.GetAsync(url);
            var json = await resp.Content.ReadAsStringAsync();
            var doc  = JsonDocument.Parse(json);
            var root = doc.RootElement;

            if (!root.TryGetProperty("rows", out var rowsProp)) return;

            var rows  = rowsProp.EnumerateArray().ToList();
            if (rows.Count == 0) return;

            _lastOffset += rows.Count;

            foreach (var row in rows)
            {
                var pkt = ParseRow(Packets.Count + 1, row);
                Packets.Add(pkt);
            }
        }
        catch { /* silently ignore polling errors */ }
    }

    // ── Parse a packet JSON element into RemoteCaptureRow ────────────────────
    private static RemoteCaptureRow ParseRow(int no, JsonElement row)
    {
        var decoded = row.TryGetProperty("decoded", out var dec) ? dec : default;
        var eth     = decoded.ValueKind != JsonValueKind.Undefined && decoded.TryGetProperty("ethernet", out var e) ? e
                    : decoded.ValueKind != JsonValueKind.Undefined && decoded.TryGetProperty("eth",      out var e2) ? e2
                    : default;

        string Get(JsonElement el, string prop) =>
            el.ValueKind != JsonValueKind.Undefined && el.TryGetProperty(prop, out var v) ? v.GetString() ?? "" : "";

        var srcMac = Get(eth, "srcMac") is { Length: > 0 } sm ? sm : Get(eth, "src");
        var dstMac = Get(eth, "dstMac") is { Length: > 0 } dm ? dm : Get(eth, "dst");

        JsonElement ipv4 = default, arp = default, ipv6 = default;
        if (decoded.ValueKind != JsonValueKind.Undefined)
        {
            decoded.TryGetProperty("ipv4",  out ipv4);
            decoded.TryGetProperty("arp",   out arp);
            decoded.TryGetProperty("ipv6",  out ipv6);
        }

        var srcIp = Get(ipv4, "src") is { Length: > 0 } si ? si
                  : Get(arp,  "senderIp") is { Length: > 0 } ai ? ai
                  : Get(ipv6, "src");

        var dstIp = Get(ipv4, "dst") is { Length: > 0 } di ? di
                  : Get(arp,  "targetIp") is { Length: > 0 } ati ? ati
                  : Get(ipv6, "dst");

        // Timestamp
        double ts = row.TryGetProperty("timestamp", out var tsProp) ? tsProp.GetDouble() : 0;
        var dt = DateTimeOffset.FromUnixTimeMilliseconds((long)(ts * 1000));
        var tStr = dt.ToLocalTime().ToString("HH:mm:ss.fff");

        // Protocol
        var proto = "ETH";
        if (decoded.ValueKind != JsonValueKind.Undefined)
        {
            if (decoded.TryGetProperty("udp",    out _)) proto = "UDP";
            else if (decoded.TryGetProperty("tcp",  out _)) proto = "TCP";
            else if (decoded.TryGetProperty("icmp", out _)) proto = "ICMP";
            else if (decoded.TryGetProperty("arp",  out _)) proto = "ARP";
            else if (decoded.TryGetProperty("ipv6", out _)) proto = "IPv6";
            else if (decoded.TryGetProperty("ipv4", out _)) proto = "IPv4";
        }

        var iface  = row.TryGetProperty("interface", out var ifProp) ? ifProp.GetString() ?? "" : "";
        var length = row.TryGetProperty("length",    out var lenProp) ? lenProp.GetInt32() : 0;
        var detail = decoded.ValueKind != JsonValueKind.Undefined
            ? JsonSerializer.Serialize(decoded, new JsonSerializerOptions { WriteIndented = true })
            : "";

        return new RemoteCaptureRow
        {
            No            = no,
            Time          = tStr,
            InterfaceName = iface,
            SrcMac        = srcMac,
            DstMac        = dstMac,
            Source        = srcIp,
            Destination   = dstIp,
            Protocol      = proto,
            Length        = length,
            Info          = $"{srcMac} → {dstMac}",
            DetailJson    = detail
        };
    }

    // ── PASS/FAIL evaluation ──────────────────────────────────────────────────
    private void Evaluate()
    {
        var addr = (TargetAddress ?? "").Trim().ToLowerInvariant();
        if (string.IsNullOrEmpty(addr))
        {
            ResultText = "";
            return;
        }

        var matches = Packets.Where(p => RowMatchesAddr(p, addr)).ToList();
        var verdict = matches.Count > 0 ? "PASS" : "FAIL";
        ResultText = $"{verdict}  —  Target: {addr}  |  Matched: {matches.Count} packet(s)";
        Status     = $"{verdict}: {matches.Count} packet(s) matched address '{addr}'.";
    }

    private static bool RowMatchesAddr(RemoteCaptureRow row, string addr)
    {
        // IP match
        if (System.Text.RegularExpressions.Regex.IsMatch(addr, @"^\d{1,3}\.\d{1,3}"))
        {
            return row.Source.Contains(addr, StringComparison.OrdinalIgnoreCase) ||
                   row.Destination.Contains(addr, StringComparison.OrdinalIgnoreCase);
        }
        // MAC match (substring)
        var normAddr = addr.Replace("-", ":").Replace(" ", "");
        var normSrc  = row.SrcMac.ToLowerInvariant().Replace("-", ":");
        var normDst  = row.DstMac.ToLowerInvariant().Replace("-", ":");
        return normSrc.Contains(normAddr) || normDst.Contains(normAddr);
    }

    // ── IDisposable ───────────────────────────────────────────────────────────
    public void Dispose()
    {
        _pollTimer?.Stop();
        _pollTimer = null;
    }
}
