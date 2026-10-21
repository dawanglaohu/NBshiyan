$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null=[Windows.Media.Transcoding.MediaTranscoder,Windows.Media,ContentType=WindowsRuntime]
$null=[Windows.Media.MediaProperties.MediaEncodingProfile,Windows.Media,ContentType=WindowsRuntime]
$null=[Windows.Media.MediaProperties.VideoEncodingQuality,Windows.Media,ContentType=WindowsRuntime]
$null=[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
$null=[Windows.Storage.StorageFolder,Windows.Storage,ContentType=WindowsRuntime]
$null=[Windows.Storage.CreationCollisionOption,Windows.Storage,ContentType=WindowsRuntime]
function Await-Operation($Operation, [Type]$ResultType) {
  $method=[System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {$_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'} | Select-Object -First 1
  $task=$method.MakeGenericMethod($ResultType).Invoke($null,@($Operation))
  $task.GetAwaiter().GetResult()
}
function Await-Action($Operation) {
  $method=[System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {$_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncActionWithProgress`1'} | Select-Object -First 1
  $task=$method.MakeGenericMethod([double]).Invoke($null,@($Operation))
  $task.GetAwaiter().GetResult()
}
$inputPath='C:\Users\admin\Desktop\video2.mp4'
$outputFolder='D:\xiangmu\.codex-plans\NBshiyan-m1-t3'
$outputName='video2-mediafoundation-720p60-candidate.mp4'
if(Test-Path -LiteralPath (Join-Path $outputFolder $outputName)){throw 'Probe output already exists; refusing overwrite'}
$source=Await-Operation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($inputPath)) ([Windows.Storage.StorageFile])
$folder=Await-Operation ([Windows.Storage.StorageFolder]::GetFolderFromPathAsync($outputFolder)) ([Windows.Storage.StorageFolder])
$dest=Await-Operation ($folder.CreateFileAsync($outputName,[Windows.Storage.CreationCollisionOption]::FailIfExists)) ([Windows.Storage.StorageFile])
$originalProfile=Await-Operation ([Windows.Media.MediaProperties.MediaEncodingProfile]::CreateFromFileAsync($source)) ([Windows.Media.MediaProperties.MediaEncodingProfile])
$profile=[Windows.Media.MediaProperties.MediaEncodingProfile]::CreateMp4([Windows.Media.MediaProperties.VideoEncodingQuality]::HD720p)
$profile.Video.FrameRate.Numerator=60
$profile.Video.FrameRate.Denominator=1
$profile.Video.Bitrate=2500000
$profile.Audio=$originalProfile.Audio
$transcoder=New-Object Windows.Media.Transcoding.MediaTranscoder
$transcoder.HardwareAccelerationEnabled=$false
$result=Await-Operation ($transcoder.PrepareFileTranscodeAsync($source,$dest,$profile)) ([Windows.Media.Transcoding.PrepareTranscodeResult])
if(-not $result.CanTranscode){throw ('Cannot transcode: '+$result.FailureReason)}
Await-Action ($result.TranscodeAsync())
$output=[ordered]@{source=$inputPath;output=$dest.Path;tool='Windows.Media.Transcoding.MediaTranscoder';hardwareAcceleration=$false;video=[ordered]@{width=$profile.Video.Width;height=$profile.Video.Height;frameRateNumerator=$profile.Video.FrameRate.Numerator;frameRateDenominator=$profile.Video.FrameRate.Denominator;bitrate=$profile.Video.Bitrate;subtype=$profile.Video.Subtype};audio=[ordered]@{subtype=$profile.Audio.Subtype;sampleRate=$profile.Audio.SampleRate;channelCount=$profile.Audio.ChannelCount;bitrate=$profile.Audio.Bitrate};trimStartSet=$false;trimStopSet=$false;releaseAllowed=$false}
$output | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $outputFolder 'media-transcoder-operation.json') -Encoding UTF8
$output | ConvertTo-Json -Depth 8
