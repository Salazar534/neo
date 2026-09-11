# Continuous Windows dictation → stdout lines (UTF-8)
Add-Type -AssemblyName System.Speech
$ErrorActionPreference = 'Stop'
try {
  $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine
  $engine.SetInputToDefaultAudioDevice()
  $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
  $engine.InitialSilenceTimeout = [TimeSpan]::FromSeconds(0.5)
  $engine.BabbleTimeout = [TimeSpan]::FromSeconds(2)
  $engine.EndSilenceTimeout = [TimeSpan]::FromSeconds(0.8)

  Register-ObjectEvent -InputObject $engine -EventName SpeechRecognized -Action {
    $t = $EventArgs.Result.Text
    if ($t) {
      [Console]::Out.WriteLine($t)
      [Console]::Out.Flush()
    }
  } | Out-Null

  $engine.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
  Write-Output "NEO_VOICE_READY"
  [Console]::Out.Flush()
  while ($true) { Start-Sleep -Seconds 3600 }
} catch {
  Write-Output ("NEO_VOICE_ERROR:" + $_.Exception.Message)
  exit 1
}
