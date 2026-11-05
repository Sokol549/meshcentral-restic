[CmdletBinding()]
param(
    [ValidateSet('menu', 'initialize', 'backup', 'remove', 'test', 'settings', 'help')]
    [string]$Action = 'menu',
    [switch]$Yes
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:PackageDirectory = $PSScriptRoot
. (Join-Path $PSScriptRoot 'restic-storage.ps1')
. (Join-Path $PSScriptRoot 'restic-settings.ps1')
$script:Config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($script:Config.User -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$' -or $script:Config.User.EndsWith('.')) {
    throw 'Invalid pharmacy user name.'
}
$script:InstalledDirectory = Join-Path 'C:\restic' $script:Config.User
$legacyConfig = 'C:\restic\config.json'
if (-not (Test-Path -LiteralPath (Join-Path $script:InstalledDirectory 'config.json')) -and (Test-Path -LiteralPath $legacyConfig)) {
    $legacy = Get-Content -LiteralPath $legacyConfig -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($legacy.User -eq $script:Config.User) { $script:InstalledDirectory = 'C:\restic' }
}
$script:PowerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
function Invoke-ManagedAction {
    param([string]$SelectedAction)
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if ($identity.User.Value -ne 'S-1-5-18' -and -not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Нужен CMD с правами администратора либо терминал MeshCentral от SYSTEM.'
    }
    switch ($SelectedAction) {
        'settings' { Invoke-LocalSettings -Directory $script:InstalledDirectory }
        'initialize' {
            $resolved=Resolve-OneCDSourcePath -ConfiguredPath $script:Config.SourcePath -AllowPrompt:($Action -eq 'menu')
            if($resolved -ne $script:Config.SourcePath){$script:Config.SourcePath=$resolved;Save-ResticConfig -Path (Join-Path $script:PackageDirectory 'config.json') -Config $script:Config}
            & $script:PowerShellPath -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $script:PackageDirectory 'deploy-restic.ps1')
            if ($LASTEXITCODE -ne 0) { throw "Ошибка инициализации, код $LASTEXITCODE." }
            $script:InstalledDirectory = Join-Path 'C:\restic' $script:Config.User
        }
        { $_ -in 'backup', 'test' } {
            $directory = $script:InstalledDirectory
            $installedConfig = Join-Path $directory 'config.json'
            if ($SelectedAction -eq 'test') { $directory = $script:PackageDirectory }
            if ($SelectedAction -eq 'test') {
                $resolved=Resolve-OneCDSourcePath -ConfiguredPath $script:Config.SourcePath -AllowPrompt:($Action -eq 'menu')
                if($resolved -ne $script:Config.SourcePath){$script:Config.SourcePath=$resolved;Save-ResticConfig -Path (Join-Path $script:PackageDirectory 'config.json') -Config $script:Config}
            }
            if (-not (Test-Path -LiteralPath (Join-Path $directory 'backup.ps1'))) {
                if ($SelectedAction -ne 'test') { throw 'Сначала выполните инициализацию (пункт 1).' }
                $directory = $script:PackageDirectory
                Write-Host 'Проверка пакета до установки. Планировщик не изменяется.'
            }
            $arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $directory 'backup.ps1'))
            if ($SelectedAction -eq 'test') {
                $arguments += '-TestRun'
                if (Test-Path -LiteralPath $installedConfig) {
                    $installedSettings=Get-Content -LiteralPath $installedConfig -Raw -Encoding UTF8 | ConvertFrom-Json
                    if ((Get-RemoteRepository $installedSettings) -eq (Get-RemoteRepository $script:Config) -and
                        $installedSettings.Password -ceq $script:Config.Password -and $installedSettings.SourcePath -eq $script:Config.SourcePath) {
                        $arguments += @('-ConfigPath', $installedConfig)
                        Write-Host 'Проверка текущего пакета с установленными настройками точки.'
                    }
                    else { Write-Host 'Настройки хранилища изменились. Тестируются настройки нового EXE; задание не изменяется.' }
                }
                else { Write-Host 'Проверка пакета до установки. Планировщик не изменяется.' }
                Write-Host 'Тест создаёт настоящую резервную копию. Удаление старых снимков отключено.'
            }
            & $script:PowerShellPath @arguments
            if ($LASTEXITCODE -ne 0) { throw "Бэкап завершился с ошибкой, код $LASTEXITCODE. Журналы: $directory" }
            Write-Host 'УСПЕШНО: резервное копирование завершено.'
            if ($directory -ne $script:PackageDirectory) { Write-Host "Журналы: $directory" }
        }
        'remove' {
            if (-not $Yes) {
                $answer = Read-Host "Удалить задачу и файлы точки из ${script:InstalledDirectory}? Бэкапы сохранятся. Введите YES"
                if ($answer -cne 'YES') { Write-Host 'Отменено.'; return }
            }
            $taskName = 'ResticBackup_{0}' -f $script:Config.User
            $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
            if ($null -ne $task) {
                if ($task.State -eq 'Running') { throw 'Задание сейчас выполняется. Дождитесь окончания бэкапа.' }
                Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
            }
            foreach ($name in @('config.json','config.json.previous','backup.ps1','restic-storage.ps1','restic-settings.ps1','restic-mail.ps1','restic-manager.ps1','deploy-restic.ps1','Manage-Restic.cmd','restic.exe','backup_info.log','backup_info.log.1','backup_error.log','backup_error.log.1')) {
                $path = Join-Path $script:InstalledDirectory $name
                if (Test-Path -LiteralPath $path -PathType Leaf) { Remove-Item -LiteralPath $path -Force }
            }
            if ((Test-Path -LiteralPath $script:InstalledDirectory) -and @(Get-ChildItem -LiteralPath $script:InstalledDirectory -Force).Count -eq 0) {
                Remove-Item -LiteralPath $script:InstalledDirectory -Force
            }
            Write-Host 'Задача и файлы точки удалены. Резервные копии сохранены.'
        }
    }
}
if ($Action -eq 'help') {
    Write-Host 'Usage: pharmacy.exe [menu|initialize|backup|remove|test|settings|help] [--yes]'
    Write-Host '1 initialize; 2 backup; 3 remove; 4 test; 5 settings; 0 exit'
    exit 0
}
if ($Action -ne 'menu') {
    try { Invoke-ManagedAction $Action; exit 0 }
    catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
}
while ($true) {
    Write-Host "`nRestic — точка: $($script:Config.User)"
    Write-Host ('Хранилище: ' + (Get-RemoteRepository $script:Config))
    Write-Host '1. Инициализация точки'
    Write-Host '2. Ручное создание бэкапа'
    Write-Host '3. Удаление инициализации'
    Write-Host '4. Тестовый запуск с выводом журнала'
    Write-Host '5. Настройки установленной точки / повторный замер скорости'
    Write-Host '0. Выход'
    $choice = Read-Host 'Выберите пункт'
    if ($null -eq $choice -or $choice -eq '0') { exit 0 }
    $selected = switch ($choice) { '1' {'initialize'} '2' {'backup'} '3' {'remove'} '4' {'test'} '5' {'settings'} default { $null } }
    if ($null -eq $selected) { Write-Host 'Введите номер от 0 до 5.'; continue }
    try { Invoke-ManagedAction $selected }
    catch { [Console]::Error.WriteLine($_.Exception.Message) }
}
