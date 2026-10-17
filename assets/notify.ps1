# agent-mods finish alert: a Windows toast, then an optional WAV played to the end.
# Launched detached (and hidden) by the plain mod's Stop hook and by `agent-mods notify test`.
# Windows PowerShell 5.1, no modules. Every step fails silently: an alert must never surface an
# error window or keep a hook waiting.
param(
  [Parameter(Mandatory = $true)][string]$Title,
  [string]$Message = '',
  [string]$Sound = ''
)

$ErrorActionPreference = 'Stop'

# The Windows PowerShell Start-menu shortcut's AppUserModelID ({1AC14E77-...} is the System32
# known folder). It is registered on every Windows install, so toasts show without creating our
# own shortcut or registry entry.
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'

try {
  $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
  # PowerShell names are case-insensitive, so these must not be called $title / $message.
  $titleXml = [System.Security.SecurityElement]::Escape($Title)
  $messageXml = [System.Security.SecurityElement]::Escape($Message)
  # The toast stays silent: the WAV below is the alert sound, and sound-off means none at all.
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml("<toast><visual><binding template=`"ToastGeneric`"><text>$titleXml</text><text>$messageXml</text></binding></visual><audio silent=`"true`"/></toast>")
  $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
} catch {}

try {
  if ($Sound -and (Test-Path -LiteralPath $Sound -PathType Leaf)) {
    # PlaySync keeps this process alive until the sound ends; Play() would be cut off at exit.
    $player = New-Object System.Media.SoundPlayer $Sound
    $player.PlaySync()
    $player.Dispose()
  }
} catch {}
