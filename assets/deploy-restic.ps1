[CmdletBinding()]
param(
    [Parameter()]
    [string]$ConfigPath,

    [Parameter()]
    [string]$DestinationPath,
    [switch]$MeasureOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = Join-Path $PSScriptRoot 'config.json'
}
. (Join-Path $PSScriptRoot 'restic-storage.ps1')
. (Join-Path $PSScriptRoot 'restic-settings.ps1')

function Set-DeploymentAcl {
    param([Parameter(Mandatory = $true)][string]$Path)

    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)

    $systemSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
    $administratorsSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
        [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    $propagation = [System.Security.AccessControl.PropagationFlags]::None
    $allow = [System.Security.AccessControl.AccessControlType]::Allow

    foreach ($sid in @($systemSid, $administratorsSid)) {
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
            $sid,
            [System.Security.AccessControl.FileSystemRights]::FullControl,
            $inheritance,
            $propagation,
            $allow
        )
        [void]$acl.AddAccessRule($rule)
    }

    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Invoke-DeploymentRestic {
    param(
        [Parameter(Mandatory = $true)][string]$ResticPath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$Operation,
        [switch]$AllowFailure,
        [switch]$AllowLocked,
        [string]$JsonOutputPath
    )

    $stdoutPath = Join-Path $env:TEMP ('restic-deploy-out-{0}.tmp' -f [guid]::NewGuid().ToString('N'))
    $stderrPath = Join-Path $env:TEMP ('restic-deploy-err-{0}.tmp' -f [guid]::NewGuid().ToString('N'))
    try {
        $previousPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $storageArguments = @()
            if ($Arguments[1] -like 's3:*') { $storageArguments = @(Get-StorageArguments $script:SpeedTestConfig) }
            & $ResticPath @Arguments @storageArguments 1> $stdoutPath 2> $stderrPath
            $exitCode = $LASTEXITCODE
        }
        finally {
            $ErrorActionPreference = $previousPreference
        }

        if ($exitCode -ne 0 -and -not $AllowFailure -and -not ($AllowLocked -and $exitCode -eq 11)) {
            $details = if (Test-Path -LiteralPath $stderrPath) {
                (Get-Content -LiteralPath $stderrPath -Raw).Trim()
            }
            else {
                ''
            }
            throw "Restic $Operation failed with exit code $exitCode. $details"
        }
        if ($exitCode -eq 0 -and $JsonOutputPath) { Copy-Item -LiteralPath $stdoutPath -Destination $JsonOutputPath -Force }
        return $exitCode
    }
    finally {
        Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
    }
}

function Remove-SpeedTestSnapshot {
    param([string]$ResticPath, [string]$Repository, [string]$Tag)
    $storageArguments = @()
    if ($Repository -like 's3:*') { $storageArguments = @(Get-StorageArguments $script:SpeedTestConfig) }
    $json = & $ResticPath -r $Repository snapshots --json --tag $Tag @storageArguments
    if ($LASTEXITCODE -ne 0) { throw 'Unable to list speed test snapshots.' }
    $snapshots = $json | ConvertFrom-Json
    foreach ($snapshot in $snapshots) {
        if ($null -ne $snapshot -and $snapshot.tags -contains $Tag) {
            $result = Invoke-DeploymentRestic -ResticPath $ResticPath -Arguments @('-r', $Repository, 'forget', $snapshot.id) -Operation 'speed test snapshot cleanup' -AllowLocked
            if ($result -eq 11) {
                Write-Warning ('Репозиторий занят. Установка продолжится; временный снимок замера скорости {0} оставлен в хранилище. Действующие блокировки не удаляются.' -f $snapshot.id)
                return
            }
        }
    }
}

function Measure-UploadLimitKbps {
    param(
        [Parameter(Mandatory = $true)][pscustomobject]$Config,
        [Parameter(Mandatory = $true)][string]$ResticPath,
        [Parameter(Mandatory = $true)][string]$TestDirectory
    )

    $script:SpeedTestConfig = $Config
    $repository = Get-RemoteRepository $Config
    Set-StorageEnvironment $Config
    $testTag = 'speedtest-{0}' -f [guid]::NewGuid().ToString('N')
    $testFile = Join-Path $TestDirectory ($testTag + '.dat')
    $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $testSnapshotCreated = $false

    try {
        $snapshotArgs = @('-r', $repository, 'snapshots')
        $snapshotExit = Invoke-DeploymentRestic `
            -ResticPath $ResticPath `
            -Arguments $snapshotArgs `
            -Operation 'remote repository check' `
            -AllowFailure
        if ($snapshotExit -eq 10) {
            $initArgs = @('-r', $repository, 'init')
            [void](Invoke-DeploymentRestic -ResticPath $ResticPath -Arguments $initArgs -Operation 'remote repository initialization')
        }
        elseif ($snapshotExit -ne 0) {
            throw "Cannot access repository (exit code $snapshotExit). Check the connection and credentials."
        }

        $Config = Initialize-TuningSettings $Config
        Assert-TuningSettings $Config
        $sampleJson = Join-Path $TestDirectory ($testTag + '.json')
        $sentBytes = [int64]0
        $activeSeconds = [double]0
        $maxBytes = [int64]$Config.SpeedTestMaxMiB * 1MB
        $nextBytes = [int64]8MB
        $buffer = New-Object byte[] (1MB)
        try {
            for ($sample=1; $sample -le 4 -and $sentBytes -lt $maxBytes; $sample++) {
                $size = [int64][Math]::Min($nextBytes, $maxBytes - $sentBytes)
                Write-Host ('Замер {0}: {1:N1} MiB случайных данных до хранилища; цель суммарно ~{2} с, максимум {3} MiB.' -f $sample,($size/1MB),$Config.SpeedTestSeconds,$Config.SpeedTestMaxMiB)
                $stream = [IO.File]::Open($testFile,[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::None)
                try {
                    for ($written=[int64]0; $written -lt $size;) {
                        $random.GetBytes($buffer)
                        $count=[int][Math]::Min($buffer.Length,$size-$written)
                        $stream.Write($buffer,0,$count)
                        $written += $count
                    }
                }
                finally { $stream.Dispose() }
                $backupArgs = @('-r',$repository,'backup',$testFile,'--host',$Config.User,'--tag','speedtest','--tag',$testTag,'--json','--quiet')
                $testSnapshotCreated = $true
                [void](Invoke-DeploymentRestic -ResticPath $ResticPath -Arguments $backupArgs -Operation 'pharmacy upload speed test' -JsonOutputPath $sampleJson)
                $summary = Get-Content -LiteralPath $sampleJson | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object message_type -eq 'summary' | Select-Object -Last 1
                if ($null -eq $summary -or $null -eq $summary.PSObject.Properties['total_duration'] -or [double]$summary.total_duration -le 0) { throw 'Restic did not return a valid speed test summary.' }
                $duration = [double]$summary.total_duration
                $sentBytes += $size
                $activeSeconds += $duration
                Write-Host ('Передано для замера: {0:N1} MiB; время операций Restic: {1:N1} с.' -f ($sentBytes/1MB),$activeSeconds)
                if ($activeSeconds -ge [int]$Config.SpeedTestSeconds) { break }
                $rate=$sentBytes/$activeSeconds
                $nextBytes=[int64][Math]::Max(8MB,[Math]::Ceiling($rate*([int]$Config.SpeedTestSeconds-$activeSeconds)))
            }
        }
        finally { Remove-Item -LiteralPath $sampleJson -Force -ErrorAction SilentlyContinue }
        $measuredKibPerSecond = [Math]::Round($sentBytes / 1024 / $activeSeconds)
        $limitKbps = [Math]::Max(1,[Math]::Floor($measuredKibPerSecond * [int]$Config.UploadLimitPercent / 100))
        foreach($entry in @{MeasuredUploadKibPerSecond=$measuredKibPerSecond;SpeedTestBytes=$sentBytes;SpeedTestActiveSeconds=$activeSeconds;LastSpeedTestUtc=[DateTime]::UtcNow.ToString('o')}.GetEnumerator()) {
            $Config | Add-Member -NotePropertyName $entry.Key -NotePropertyValue $entry.Value -Force
        }
        Remove-SpeedTestSnapshot -ResticPath $ResticPath -Repository $repository -Tag $testTag
        $testSnapshotCreated = $false

        Write-Host ('Скорость резервирования: {0} KiB/s; лимит ({1}%): {2} KiB/s' -f $measuredKibPerSecond, $Config.UploadLimitPercent, $limitKbps)
        return [int]$limitKbps
    }
    finally {
        if ($testSnapshotCreated) {
            try {
                Remove-SpeedTestSnapshot -ResticPath $ResticPath -Repository $repository -Tag $testTag
            }
            catch {
                Write-Warning "Unable to clean up the temporary speed test snapshot: $($_.Exception.Message)"
            }
        }
        $random.Dispose()
        Remove-Item -LiteralPath $testFile -Force -ErrorAction SilentlyContinue
        Remove-Item Env:\RESTIC_PASSWORD -ErrorAction SilentlyContinue
        Clear-StorageEnvironment
    }
}

try {
    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
        throw "Configuration file not found: $ConfigPath"
    }

    $backupScriptSource = Join-Path $PSScriptRoot 'backup.ps1'
    $resticSource = Join-Path $PSScriptRoot 'restic.exe'
    foreach ($sourceFile in @($backupScriptSource, $resticSource)) {
        if (-not (Test-Path -LiteralPath $sourceFile -PathType Leaf)) {
            throw "Required deployment asset not found: $sourceFile"
        }
    }

    $config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $config = Initialize-TuningSettings $config
    Assert-TuningSettings $config
    foreach ($property in @('User', 'Password', 'SourcePath', 'UploadLimitKbps', 'MinFreeHddGb')) {
        if ($null -eq $config.PSObject.Properties[$property] -or
            [string]::IsNullOrWhiteSpace([string]$config.$property)) {
            throw "Configuration property '$property' is missing or empty."
        }
    }

    if ($config.User -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$' -or $config.User.EndsWith('.')) {
        throw 'User may contain only ASCII letters, digits, dot, underscore, and hyphen.'
    }
    if (-not (Test-Path -LiteralPath $config.SourcePath -PathType Leaf)) {
        throw "Backup source file not found: $($config.SourcePath)"
    }
    if ([string]::IsNullOrWhiteSpace($DestinationPath)) {
        $DestinationPath = Join-Path 'C:\restic' $config.User
    }
    Assert-StorageConfig $config
    if ([int]$config.UploadLimitKbps -lt 1 -or [int]$config.MinFreeHddGb -lt 1) {
        throw 'UploadLimitKbps and MinFreeHddGb must be positive integers.'
    }

    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
    $isSystem = $identity.User.Value -eq 'S-1-5-18'
    if (-not $isSystem -and -not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run deployment from an elevated PowerShell session.'
    }
    if ($MeasureOnly) {
        $config.UploadLimitKbps = Measure-UploadLimitKbps -Config $config -ResticPath (Join-Path $DestinationPath 'restic.exe') -TestDirectory $DestinationPath
        $config.UploadLimitMode = 'Auto'
        Save-ResticConfig -Path $ConfigPath -Config $config
        Write-Host 'Новый лимит сохранён. Расписание не изменено.'
        return
    }

    if (-not (Test-Path -LiteralPath $DestinationPath -PathType Container)) {
        New-Item -Path $DestinationPath -ItemType Directory -Force | Out-Null
    }
    Set-DeploymentAcl -Path $DestinationPath

    $targetConfig = Join-Path $DestinationPath 'config.json'
    $targetBackup = Join-Path $DestinationPath 'backup.ps1'
    $targetRestic = Join-Path $DestinationPath 'restic.exe'
    if (Test-Path -LiteralPath $targetConfig) {
        $previous=Get-Content -LiteralPath $targetConfig -Raw -Encoding UTF8 | ConvertFrom-Json
        if ((Get-RemoteRepository $previous) -eq (Get-RemoteRepository $config) -and $previous.Password -ceq $config.Password) {
            $previous=Initialize-TuningSettings $previous
            foreach($key in @('UploadLimitKbps','UploadLimitMode','UploadLimitPercent','SpeedTestSeconds','SpeedTestMaxMiB','MinFreeHddGb')) { $config.$key=$previous.$key }
            foreach($key in @('MeasuredUploadKibPerSecond','SpeedTestBytes','SpeedTestActiveSeconds','LastSpeedTestUtc')) {
                if($null -ne $previous.PSObject.Properties[$key]) { $config | Add-Member -NotePropertyName $key -NotePropertyValue $previous.$key -Force }
            }
            Assert-TuningSettings $config
        }
    }
    foreach ($name in @('backup.ps1','restic.exe','restic-storage.ps1','restic-settings.ps1','restic-mail.ps1','restic-manager.ps1','deploy-restic.ps1')) {
        $source=Join-Path $PSScriptRoot $name
        $destination=Join-Path $DestinationPath $name
        if ([IO.Path]::GetFullPath($source) -ne [IO.Path]::GetFullPath($destination)) { Copy-Item -LiteralPath $source -Destination $destination -Force }
    }
    $managerCommand = "@echo off`r`npowershell.exe -NoProfile -ExecutionPolicy Bypass -File `"%~dp0restic-manager.ps1`" %*`r`nexit /b %errorlevel%`r`n"
    [IO.File]::WriteAllText((Join-Path $DestinationPath 'Manage-Restic.cmd'),$managerCommand,[Text.Encoding]::ASCII)

    if ($config.UploadLimitMode -eq 'Auto') {
        $config.UploadLimitKbps = Measure-UploadLimitKbps `
        -Config $config `
        -ResticPath $targetRestic `
        -TestDirectory $DestinationPath
    }
    Save-ResticConfig -Path $targetConfig -Config $config

    $powerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-Path -LiteralPath $powerShellPath -PathType Leaf)) {
        throw "Windows PowerShell 5.1 was not found: $powerShellPath"
    }

    $taskName = 'ResticBackup_{0}' -f $config.User
    $taskArguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}"' -f $targetBackup
    $action = New-ScheduledTaskAction `
        -Execute $powerShellPath `
        -Argument $taskArguments `
        -WorkingDirectory $DestinationPath
    $trigger = New-ScheduledTaskTrigger -Daily -At '09:00'
    $settings = New-ScheduledTaskSettingsSet `
        -StartWhenAvailable `
        -MultipleInstances IgnoreNew `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 15)
    $taskPrincipal = New-ScheduledTaskPrincipal `
        -UserId 'NT AUTHORITY\SYSTEM' `
        -LogonType ServiceAccount `
        -RunLevel Highest

    Register-ScheduledTask `
        -TaskName $taskName `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Principal $taskPrincipal `
        -Description "Restic backup for $($config.User)" `
        -Force | Out-Null

    Write-Host "Deployment completed. Task '$taskName' runs daily at 09:00 as SYSTEM."
    Write-Host "Installed files: $DestinationPath"
}
catch {
    [Console]::Error.WriteLine(('[{0}] Deployment failed: {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $_.Exception.Message))
    exit 1
}
