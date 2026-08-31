# local-speech.ps1 — Windows SAPI dictation worker (resilient edition)
#
# Emits newline-delimited JSON events on stdout:
#   { type: 'transcript', text, confidence }
#   { type: 'status', status: 'READY'|'STARTED'|'RESTARTED', message }
#   { type: 'diagnostic', event, ... }
#   { type: 'error', event?, message }
#
# Resilience contract (learned from real Windows-machine failures):
#  1. Selects an EXPLICIT installed recognizer (prefers en-US). The old code
#     used `new SpeechRecognitionEngine()` which binds to the recognizer for
#     the CURRENT UI culture — on machines whose display language has no
#     desktop recognizer, this fails outright or misbehaves asynchronously.
#  2. Microphone open failures produce ACTIONABLE messages (privacy settings,
#     exclusive lock, no default device) instead of raw COM error text.
#  3. When SAPI recognition dies asynchronously (RecognizeCompleted with an
#     error — the failure seen on real machines), the worker REBUILDS the
#     recognizer and resumes listening, up to 4 attempts. It used to stay
#     alive but deaf, forcing the whole pipeline to be torn down.
#  4. A silent-mic watchdog reports "no audio signal" hints so users with a
#     muted/blocked mic get told WHY instead of hearing nothing.

function Write-Event($payload) {
  [Console]::WriteLine(($payload | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

try {
  # UTF-8 stdout so device names with non-ASCII characters survive the pipe.
  try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

  Write-Event @{ type = 'diagnostic'; event = 'MIC_DEVICE_ENUMERATION_START' }
  $audioEndpoints = @(Get-PnpDevice -Class AudioEndpoint -Status OK -ErrorAction SilentlyContinue)
  foreach ($endpoint in $audioEndpoints) {
    Write-Event @{ type = 'diagnostic'; event = 'MIC_DEVICE'; name = $endpoint.FriendlyName; id = $endpoint.InstanceId }
  }
  $recordMapper = (Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Multimedia\Sound Mapper' -Name Record -ErrorAction SilentlyContinue).Record
  if ($recordMapper) {
    Write-Event @{ type = 'diagnostic'; event = 'MIC_DEVICE_DEFAULT'; name = $recordMapper }
  }

  Add-Type -AssemblyName System.Speech
  Add-Type -ReferencedAssemblies System.Speech -TypeDefinition @'
using System;
using System.Globalization;
using System.Speech.Recognition;

public sealed class SeraSpeechBridge : IDisposable {
  private SpeechRecognitionEngine recognizer;
  private readonly object outputLock = new object();
  private bool signalActive;
  public volatile string LastRecognizeError;
  public string RecognizerDescription = "(none)";
  private DateTime lastAudioEventUtc = DateTime.UtcNow;

  public double SecondsSinceLastAudioEvent() {
    return (DateTime.UtcNow - lastAudioEventUtc).TotalSeconds;
  }

  private static RecognizerInfo SelectRecognizer() {
    System.Collections.ObjectModel.ReadOnlyCollection<RecognizerInfo> installed = SpeechRecognitionEngine.InstalledRecognizers();
    if (installed == null || installed.Count == 0) {
      throw new InvalidOperationException(
        "Windows has no speech recognition engine installed. Fix: Settings > Time & Language > Speech > Manage voices > Add the English (United States) voice pack, then restart SERA.");
    }
    RecognizerInfo pick = null;
    foreach (RecognizerInfo info in installed) {
      if (string.Equals(info.Culture.Name, "en-US", StringComparison.OrdinalIgnoreCase)) { pick = info; break; }
    }
    if (pick == null) {
      foreach (RecognizerInfo info in installed) {
        if (info.Culture != null && info.Culture.Name.StartsWith("en", StringComparison.OrdinalIgnoreCase)) { pick = info; break; }
      }
    }
    return pick ?? installed[0];
  }

  public void Init() {
    RecognizerInfo chosen = SelectRecognizer();
    RecognizerDescription = chosen.Description + " [" + chosen.Culture.Name + "]";

    SpeechRecognitionEngine next = new SpeechRecognitionEngine(chosen);
    try {
      next.LoadGrammar(new DictationGrammar());
      next.SetInputToDefaultAudioDevice();
      next.EndSilenceTimeout = TimeSpan.FromMilliseconds(500);
      next.EndSilenceTimeoutAmbiguous = TimeSpan.FromMilliseconds(750);
      next.BabbleTimeout = TimeSpan.FromSeconds(0);
      next.InitialSilenceTimeout = TimeSpan.FromSeconds(0);
    } catch (Exception setupError) {
      next.Dispose();
      throw new InvalidOperationException(
        "SERA could not open your microphone (" + setupError.Message + "). Fix: 1) Settings > Privacy & security > Microphone > turn ON access for desktop apps. 2) Make sure a recording device is connected and not muted. 3) If another app holds the mic exclusively, close it and retry.", setupError);
    }

    if (recognizer != null) {
      try { recognizer.RecognizeAsyncCancel(); } catch {}
      try { recognizer.Dispose(); } catch {}
    }
    recognizer = next;
    signalActive = false;

    recognizer.AudioLevelUpdated += OnAudioLevelUpdated;
    recognizer.AudioSignalProblemOccurred += OnAudioSignalProblemOccurred;
    recognizer.AudioStateChanged += OnAudioStateChanged;
    recognizer.SpeechHypothesized += OnSpeechHypothesized;
    recognizer.SpeechRecognized += OnSpeechRecognized;
    recognizer.SpeechRecognitionRejected += OnSpeechRecognitionRejected;
    recognizer.RecognizeCompleted += OnRecognizeCompleted;
  }

  public void Start() {
    LastRecognizeError = null;
    recognizer.RecognizeAsync(RecognizeMode.Multiple);
  }
  public void Stop() { try { recognizer.RecognizeAsyncCancel(); } catch {} }
  public void Dispose() {
    if (recognizer != null) { try { recognizer.Dispose(); } catch {} recognizer = null; }
  }

  private void OnAudioLevelUpdated(object sender, AudioLevelUpdatedEventArgs e) {
    lastAudioEventUtc = DateTime.UtcNow;
    Write("audio", "level", e.AudioLevel.ToString(), "signal", (e.AudioLevel > 0).ToString());
    if (e.AudioLevel > 1 && !signalActive) {
      signalActive = true;
      Write("diagnostic", "event", "MIC_SIGNAL_DETECTED", "level", e.AudioLevel.ToString());
    }
    if (e.AudioLevel <= 1 && signalActive) {
      signalActive = false;
      Write("diagnostic", "event", "MIC_SIGNAL_SILENCE");
    }
  }

  private void OnAudioSignalProblemOccurred(object sender, AudioSignalProblemOccurredEventArgs e) {
    Write("diagnostic", "event", "SAPI_SIGNAL_PROBLEM", "problem", e.AudioSignalProblem.ToString(), "level", e.AudioLevel.ToString());
    if (e.AudioSignalProblem == AudioSignalProblem.NoSignal) {
      Write("diagnostic", "event", "MIC_SIGNAL_ERROR", "message", "The microphone delivers no signal. Check: mic not muted, default recording device selected, Settings > Privacy & security > Microphone allows desktop apps.");
    }
  }

  private void OnAudioStateChanged(object sender, AudioStateChangedEventArgs e) {
    lastAudioEventUtc = DateTime.UtcNow;
    Write("diagnostic", "event", "SAPI_AUDIO_STATE", "state", e.AudioState.ToString());
  }

  private void OnSpeechHypothesized(object sender, SpeechHypothesizedEventArgs e) {
    lastAudioEventUtc = DateTime.UtcNow;
    if (e.Result != null && !string.IsNullOrWhiteSpace(e.Result.Text)) {
      Write("transcript", "text", e.Result.Text, "confidence", e.Result.Confidence.ToString(System.Globalization.CultureInfo.InvariantCulture), "isHypothesis", "true");
    }
  }

  private void OnSpeechRecognized(object sender, SpeechRecognizedEventArgs e) {
    lastAudioEventUtc = DateTime.UtcNow;
    if (e.Result != null && !string.IsNullOrWhiteSpace(e.Result.Text)) {
      Write("transcript", "text", e.Result.Text, "confidence", e.Result.Confidence.ToString(System.Globalization.CultureInfo.InvariantCulture));
    }
  }

  private void OnSpeechRecognitionRejected(object sender, SpeechRecognitionRejectedEventArgs e) {
    lastAudioEventUtc = DateTime.UtcNow;
    float conf = e.Result != null ? e.Result.Confidence : 0f;
    string txt = e.Result != null ? e.Result.Text : "";
    Write("diagnostic", "event", "SPEECH_REJECTED", "confidence", conf.ToString(System.Globalization.CultureInfo.InvariantCulture), "text", txt);
  }

  private void OnRecognizeCompleted(object sender, RecognizeCompletedEventArgs e) {
    if (e.Error != null) {
      LastRecognizeError = e.Error.Message ?? e.Error.GetType().Name;
      Write("error", "event", "SAPI_RECOGNIZE_ERROR", "message", LastRecognizeError);
    } else if (e.Cancelled) {
      Write("diagnostic", "event", "SAPI_RECOGNIZE_CANCELLED");
    }
  }

  private void Write(string type, params string[] values) {
    lock (outputLock) {
      Console.Write("{\"type\":\""); Console.Write(Escape(type)); Console.Write("\"");
      for (int i = 0; i + 1 < values.Length; i += 2) {
        Console.Write(",\""); Console.Write(Escape(values[i])); Console.Write("\":");
        if (values[i] == "level") Console.Write(values[i + 1]);
        else if (values[i] == "signal") Console.Write(values[i + 1].ToLowerInvariant());
        else { Console.Write("\""); Console.Write(Escape(values[i + 1])); Console.Write("\""); }
      }
      Console.WriteLine("}"); Console.Out.Flush();
    }
  }
  private static string Escape(string value) { return (value ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n"); }
}
'@ -ErrorAction Stop

  $bridge = New-Object SeraSpeechBridge
  $bridge.Init()
  Write-Event @{ type = 'diagnostic'; event = 'MIC_DEVICE_SELECTED'; name = $bridge.RecognizerDescription }
  Write-Event @{ type = 'diagnostic'; event = 'MIC_DEVICE_READY' }
  Write-Event @{ type = 'status'; status = 'READY'; message = 'Windows SAPI microphone ready' }
  $bridge.Start()
  Write-Event @{ type = 'status'; status = 'STARTED'; message = 'Windows SAPI recognition started' }
  Write-Event @{ type = 'diagnostic'; event = 'ENGINE_RUNNING' }

  # Supervisor loop: keep recognition alive for the lifetime of the worker.
  # A RecognizeCompleted-with-error or an Init failure triggers a rebuild;
  # consecutive fatal rebuilds give up with an actionable message.
  $maxFatal = 4
  $fatalCount = 0
  $restarts = 0
  $silenceHinted = $false
  while ($true) {
    Start-Sleep -Milliseconds 250

    $err = $bridge.LastRecognizeError
    if ($err) {
      $fatalCount += 1
      if ($fatalCount -gt $maxFatal) {
        Write-Event @{ type = 'error'; event = 'SAPI_FATAL'; message = "Windows speech recognition failed $maxFatal times in a row. Last error: $err. Try rebooting once (this clears stuck audio devices) or switch SERA to text input; the rest of SERA keeps working." }
        exit 1
      }
      $restarts += 1
      Write-Event @{ type = 'diagnostic'; event = 'SAPI_RESTART'; attempt = $restarts; message = "Recognition stopped ($err) - rebuilding the engine (attempt $restarts/$maxFatal)." }
      Start-Sleep -Milliseconds 600
      try {
        $bridge.Init()
        $bridge.Start()
        Write-Event @{ type = 'status'; status = 'RESTARTED'; message = "Windows SAPI recognition restarted (attempt $restarts)" }
      } catch {
        Write-Event @{ type = 'error'; event = 'SAPI_RESTART_FAILED'; message = $_.Exception.Message }
        # Init failures are usually persistent (mic gone / privacy) — but keep
        # trying through the same fatal budget so transient USB hiccups heal.
      }
      continue
    }

    # Silence watchdog: if the engine reports zero audio activity for a long
    # stretch (any event resets it), surface a hint so muted/blocked mics are
    # explainable. This does NOT restart — silence is a valid state.
    if ($bridge.SecondsSinceLastAudioEvent() -gt 60 -and -not $silenceHinted) {
      $silenceHinted = $true
      Write-Event @{ type = 'diagnostic'; event = 'MIC_SIGNAL_ERROR'; message = 'No microphone signal for 60 seconds. If SERA never hears you: un-mute the mic, pick the right default recording device, and allow desktop apps in Settings > Privacy & security > Microphone.' }
    } elseif ($bridge.SecondsSinceLastAudioEvent() -le 5) {
      $silenceHinted = $false
    }

    # A healthy stretch (audio flowing, no pending error) clears the fatal
    # budget so sporadic hiccups hours apart never compound into a shutdown.
    if (-not $err -and $bridge.SecondsSinceLastAudioEvent() -lt 30) {
      $fatalCount = 0
    }
  }
} catch {
  Write-Event @{ type = 'error'; message = $_.Exception.Message }
  exit 1
}
