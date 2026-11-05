[CmdletBinding()]
param(
    [switch]$TestRun,
    [string]$ConfigPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:BaseDirectory = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($script:BaseDirectory)) {
    $script:BaseDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
}
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = Join-Path $script:BaseDirectory 'config.json'
}
$script:ConfigPath = $ConfigPath
$script:ResticPath = Join-Path $script:BaseDirectory 'restic.exe'
$script:InfoLogPath = Join-Path $script:BaseDirectory 'backup_info.log'
$script:ErrorLogPath = Join-Path $script:BaseDirectory 'backup_error.log'
$script:MaximumLogSize = 10MB
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$script:LocalBackupFailed = $false
$script:RemoteBackupFailed = $false
$script:RunMutex = $null
$script:OwnsMutex = $false
$script:BackupStarted = Get-Date
$script:BackupExitCode = 1
$script:BackupFailure = ''
$script:ReportSettings = $null
$script:ReportPoint = $env:COMPUTERNAME
$script:StatusPath = Join-Path $script:BaseDirectory 'backup_status.json'
$script:BackupStatus = $null
. (Join-Path $script:BaseDirectory 'restic-storage.ps1')
. (Join-Path $script:BaseDirectory 'restic-settings.ps1')
. (Join-Path $script:BaseDirectory 'restic-mail.ps1')

function Clear-ResticProgress {
    $state = Get-Variable -Name ResticProgressLength -Scope Script -ErrorAction SilentlyContinue
    if ($null -ne $state -and $state.Value -gt 0) {
        Write-Host -NoNewline ("`r" + (' ' * $state.Value) + "`r")
        $script:ResticProgressLength = 0
    }
}

function Show-ResticProgress {
    param([string]$Text)
    if (-not $TestRun) { return }
    $width = 100
    try { if ([Console]::WindowWidth -gt 20) { $width = [Console]::WindowWidth - 1 } } catch { }
    if ($Text.Length -gt $width) { $Text = $Text.Substring(0, $width - 3) + '...' }
    $state = Get-Variable -Name ResticProgressLength -Scope Script -ErrorAction SilentlyContinue
    $previous = if ($null -ne $state) { [int]$state.Value } else { 0 }
    Write-Host -NoNewline ("`r" + $Text.PadRight([Math]::Max($Text.Length, [Math]::Min($previous, $width))))
    $script:ResticProgressLength = $Text.Length
}

function Write-Log {
    param(
        [Parameter(Mandatory = $true)][string]$Message,
        [Parameter(Mandatory = $true)][ValidateSet('Info', 'Error')][string]$Level,
        [switch]$ConsoleQuiet
    )

    $path = if ($Level -eq 'Error') { $script:ErrorLogPath } else { $script:InfoLogPath }
    $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    if ($TestRun -and -not $ConsoleQuiet) { Clear-ResticProgress; Write-Host $line }

    if (Test-Path -LiteralPath $path) {
        $file = Get-Item -LiteralPath $path
        if ($file.Length -ge $script:MaximumLogSize) {
            $previousLog = "$path.1"
            if (Test-Path -LiteralPath $previousLog) {
                Remove-Item -LiteralPath $previousLog -Force
            }
            Move-Item -LiteralPath $path -Destination $previousLog
        }
    }

    [System.IO.File]::AppendAllText($path, $line + [Environment]::NewLine, $script:Utf8NoBom)
}

function Get-ResticField {
    param($Record, [string]$Name, $Default = 0)
    if ($null -ne $Record.PSObject.Properties[$Name]) { return $Record.$Name }
    return $Default
}

function Save-BackupStatus {
    if ($TestRun -or $null -eq $script:BackupStatus) { return }
    $tmp = $script:StatusPath + '.tmp'
    try {
        $json = $script:BackupStatus | ConvertTo-Json -Depth 5 -Compress
        [IO.File]::WriteAllText($tmp, $json, $script:Utf8NoBom)
        if ([IO.File]::Exists($script:StatusPath)) { [IO.File]::Replace($tmp, $script:StatusPath, ($script:StatusPath + '.previous')) }
        else { [IO.File]::Move($tmp, $script:StatusPath) }
    } catch {
        try { Write-Log -Level Error -Message 'Failed to save backup monitoring status.' } catch { }
    }
}

function Initialize-BackupStatus {
    if ($TestRun) { return }
    $lastId = ''; $lastTime = ''; $lastSnapshot = ''
    if (Test-Path -LiteralPath $script:StatusPath) {
        try {
            $previous = Get-Content -LiteralPath $script:StatusPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($null -ne $previous.PSObject.Properties['last_confirmed_id']) { $lastId = [string]$previous.last_confirmed_id }
            if ($null -ne $previous.PSObject.Properties['last_confirmed_utc']) { $lastTime = [string]$previous.last_confirmed_utc }
            if ($null -ne $previous.PSObject.Properties['last_snapshot_utc']) { $lastSnapshot = [string]$previous.last_snapshot_utc }
        } catch { }
    }
    $script:BackupStatus = [ordered]@{ schema = 1; started_utc = [DateTime]::UtcNow.ToString('o'); completed_utc = ''; backup = 'pending'; backup_exit_code = -1; verification = 'pending'; cleanup = 'pending'; last_confirmed_id = $lastId; last_confirmed_utc = $lastTime; last_snapshot_utc = $lastSnapshot }
    Save-BackupStatus
}

function Write-ResticLiveLine {
    param([string]$Line, [string]$Level = 'Info')
    if ([string]::IsNullOrWhiteSpace($Line)) { return }
    $record = $null
    if ($Line.TrimStart().StartsWith('{')) {
        try { $record = $Line | ConvertFrom-Json } catch { }
    }
    if ($null -ne $record -and $null -ne $record.PSObject.Properties['message_type']) {
        switch ($record.message_type) {
            'status' {
                $percent = 100 * [double](Get-ResticField $record 'percent_done')
                $done = [double](Get-ResticField $record 'bytes_done') / 1MB
                $total = [double](Get-ResticField $record 'total_bytes') / 1MB
                $elapsed = [int64](Get-ResticField $record 'seconds_elapsed')
                $message = 'Прогресс: {0:N1}% | обработано {1:N1} / {2:N1} MiB | файлов {3}/{4} | прошло {5} с' -f $percent, $done, $total, (Get-ResticField $record 'files_done'), (Get-ResticField $record 'total_files'), $elapsed
                if ($null -ne $record.PSObject.Properties['seconds_remaining']) { $message += ' | осталось ~{0} с' -f $record.seconds_remaining }
                $current = @(Get-ResticField $record 'current_files' @())
                if ($current.Count -gt 0) { $message += ' | сейчас: ' + ($current -join '; ') }
                Write-Log -Level Info -Message $message -ConsoleQuiet
                $filled = [int][Math]::Floor([Math]::Max(0, [Math]::Min(100, $percent)) / 5)
                $compact = '[{0}{1}] {2:N1}% | {3:N1}/{4:N1} MiB | {5} с' -f ('#' * $filled), ('-' * (20 - $filled)), $percent, $done, $total, $elapsed
                if ($null -ne $record.PSObject.Properties['seconds_remaining']) { $compact += ' | ещё ~{0} с' -f $record.seconds_remaining }
                Show-ResticProgress $compact
                return
            }
            'verbose_status' {
                if ((Get-ResticField $record 'action' '') -eq 'scan_finished') {
                    $scan = 'Сканирование завершено: файлов {0}. Подготовка снимка...' -f (Get-ResticField $record 'total_files')
                    Write-Log -Level Info -Message $scan -ConsoleQuiet
                    Show-ResticProgress $scan
                    return
                }
                Write-Log -Level Info -Message ('{0}: {1}' -f (Get-ResticField $record 'action' ''), (Get-ResticField $record 'item' '')) -ConsoleQuiet
                return
            }
            'summary' {
                Write-Log -Level Info -Message ('Снимок сохранён: {0} | файлов: {1} | объём: {2:N1} MiB | время: {3:N1} с' -f (Get-ResticField $record 'snapshot_id' ''), (Get-ResticField $record 'total_files_processed'), ([double](Get-ResticField $record 'total_bytes_processed') / 1MB), (Get-ResticField $record 'total_duration'))
                return
            }
            'error' { $Level = 'Error' }
        }
    }
    Write-Log -Level $Level -Message $Line
}

function ConvertTo-ResticArgument {
    param([AllowEmptyString()][string]$Value)
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}

function Invoke-LiveRestic {
    param([string[]]$Arguments)
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $script:ResticPath
    $info.Arguments = (($Arguments | ForEach-Object { ConvertTo-ResticArgument $_ }) -join ' ')
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $info.StandardErrorEncoding = New-Object System.Text.UTF8Encoding($false)
    $info.EnvironmentVariables['RESTIC_PROGRESS_FPS'] = '1'
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $info
    try {
        [void]$process.Start()
        $process.StandardInput.Close()
        Write-Log -Level Info -Message ('Restic запущен, PID {0}.' -f $process.Id) -ConsoleQuiet
        Show-ResticProgress 'Подготовка Restic / VSS / сканирование...'
        $stdout = $process.StandardOutput.ReadLineAsync()
        $stderr = $process.StandardError.ReadLineAsync()
        $timer = [Diagnostics.Stopwatch]::StartNew()
        $lastOutput = $timer.Elapsed.TotalSeconds
        while ($null -ne $stdout -or $null -ne $stderr -or -not $process.HasExited) {
            if ($null -ne $stdout -and $stdout.IsCompleted) {
                $line = $stdout.GetAwaiter().GetResult()
                $stdout = $null
                if ($null -ne $line) {
                    Write-ResticLiveLine -Line $line
                    $lastOutput = $timer.Elapsed.TotalSeconds
                    $stdout = $process.StandardOutput.ReadLineAsync()
                }
            }
            if ($null -ne $stderr -and $stderr.IsCompleted) {
                $line = $stderr.GetAwaiter().GetResult()
                $stderr = $null
                if ($null -ne $line) {
                    Write-ResticLiveLine -Line $line -Level Error
                    $lastOutput = $timer.Elapsed.TotalSeconds
                    $stderr = $process.StandardError.ReadLineAsync()
                }
            }
            if ($timer.Elapsed.TotalSeconds - $lastOutput -ge 10 -and -not $process.HasExited) {
                $waiting = 'Ожидание Restic | PID {0} | прошло {1:N0} с' -f $process.Id, $timer.Elapsed.TotalSeconds
                Write-Log -Level Info -Message $waiting -ConsoleQuiet
                Show-ResticProgress $waiting
                $lastOutput = $timer.Elapsed.TotalSeconds
            }
            # Poll both streams on this thread; PowerShell callbacks on reader threads are unsafe.
            [Threading.Thread]::Sleep(50)
        }
        $process.WaitForExit()
        return $process.ExitCode
    }
    finally {
        Clear-ResticProgress
        try { if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() } } catch { }
        $process.Dispose()
    }
}

function Invoke-Restic {
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$Operation,
        [string]$JsonOutputPath
    )

    $stdoutPath = Join-Path $env:TEMP ('restic-stdout-{0}.tmp' -f [guid]::NewGuid().ToString('N'))
    $stderrPath = Join-Path $env:TEMP ('restic-stderr-{0}.tmp' -f [guid]::NewGuid().ToString('N'))
    Write-Log -Level Info -Message "Starting Restic: $Operation"

    try {
        $previousErrorActionPreference = $ErrorActionPreference
        $previousConsoleEncoding = [Console]::OutputEncoding
        try {
            [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
            $ErrorActionPreference = 'Continue'
            $storageArguments = @()
            if ($Arguments[1] -like 's3:*') { $storageArguments = @(Get-StorageArguments $config) }
            if ($TestRun -and -not $JsonOutputPath) {
                $ErrorActionPreference = 'Stop'
                $exitCode = Invoke-LiveRestic -Arguments ($Arguments + $storageArguments)
            }
            else {
                & $script:ResticPath @Arguments @storageArguments 1> $stdoutPath 2> $stderrPath
                $exitCode = $LASTEXITCODE
            }
        }
        finally {
            [Console]::OutputEncoding = $previousConsoleEncoding
            $ErrorActionPreference = $previousErrorActionPreference
        }

        if($exitCode -eq 0 -and $JsonOutputPath){Copy-Item -LiteralPath $stdoutPath -Destination $JsonOutputPath -Force}
        if (Test-Path -LiteralPath $stdoutPath) {
            foreach ($line in Get-Content -LiteralPath $stdoutPath) {
                if (-not [string]::IsNullOrWhiteSpace($line)) {
                    Write-Log -Level Info -Message $line
                }
            }
        }
        if (Test-Path -LiteralPath $stderrPath) {
            foreach ($line in Get-Content -LiteralPath $stderrPath) {
                if (-not [string]::IsNullOrWhiteSpace($line)) {
                    Write-Log -Level Error -Message $line
                }
            }
        }

        if ($exitCode -ne 0) {
            Write-Log -Level Error -Message "Restic operation '$Operation' failed with exit code $exitCode."
        }
        else {
            Write-Log -Level Info -Message "Restic operation '$Operation' completed successfully."
        }

        return $exitCode
    }
    catch {
        Write-Log -Level Error -Message "Unable to run Restic operation '$Operation': $($_.Exception.Message)"
        throw
    }
    finally {
        Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
    }
}

function Read-RepositoryCycleSnapshots([string]$Repository,$Config) {
    $json=Join-Path $env:TEMP ('restic-cycles-'+[guid]::NewGuid().ToString('N')+'.json')
    try {
        $result=Invoke-Restic -Arguments @('-r',$Repository,'snapshots','--host',$Config.User,'--tag',"plan:$($Config.User)",'--json') -Operation 'read backup cycles' -JsonOutputPath $json
        if($result -ne 0){throw 'Unable to read backup cycles; deletion stopped.'}
        Get-Content -LiteralPath $json -Raw -Encoding UTF8|ConvertFrom-Json|ForEach-Object {$_}
    } finally {if(Test-Path -LiteralPath $json){Remove-Item -LiteralPath $json -Force}}
}

function ConvertTo-ComparableResticPath([string]$Path) {
    $value = $Path.Replace('\','/').TrimEnd('/')
    $value = $value -replace '^/([A-Za-z])/', '$1:/' -replace '^/([A-Za-z]:/)', '$1'
    return $value.ToLowerInvariant()
}

function Confirm-RemoteSnapshot {
    param([string]$Repository, $Config, [string]$SourcePath, [string]$SnapshotId, [string[]]$ExpectedTags = @())
    $json = Join-Path $env:TEMP ('restic-confirm-' + [guid]::NewGuid().ToString('N') + '.json')
    try {
        $result = Invoke-Restic -Arguments @('-r',$Repository,'snapshots',$SnapshotId,'--json') -Operation 'verify remote snapshot' -JsonOutputPath $json
        if ($result -ne 0) { throw 'Remote snapshot query failed.' }
        $snapshots = @(Get-Content -LiteralPath $json -Raw -Encoding UTF8 | ConvertFrom-Json)
        if ($snapshots.Count -ne 1) { throw 'Snapshot query did not return exactly one snapshot.' }
        $snapshot = $snapshots[0]
        $source = ConvertTo-ComparableResticPath $SourcePath
        $paths = @($snapshot.paths | ForEach-Object { ConvertTo-ComparableResticPath ([string]$_) })
        if (-not ([string]$snapshot.id).StartsWith($SnapshotId, [StringComparison]::OrdinalIgnoreCase) -or $snapshot.hostname -cne $Config.User -or @($snapshot.tags) -cnotcontains "plan:$($Config.User)" -or @($snapshot.tags) -cnotcontains 'created-by:kzvs-back' -or $paths -notcontains $source) { throw 'Snapshot identity, host, tags or source path did not match.' }
        foreach ($tag in $ExpectedTags) { if (@($snapshot.tags) -cnotcontains $tag) { throw 'Snapshot is missing an expected backup tag.' } }
        $snapshotTime = [DateTimeOffset]::Parse([string]$snapshot.time).ToUniversalTime().ToString('o')
        $script:BackupStatus.verification = 'success'
        $script:BackupStatus.last_confirmed_id = [string]$snapshot.id
        $script:BackupStatus.last_snapshot_utc = $snapshotTime
        $script:BackupStatus.last_confirmed_utc = [DateTime]::UtcNow.ToString('o')
        Save-BackupStatus
    } finally { if (Test-Path -LiteralPath $json) { Remove-Item -LiteralPath $json -Force -ErrorAction SilentlyContinue } }
}

function Invoke-RepositoryBackup {
    param(
        [Parameter(Mandatory = $true)][string]$Repository,
        [Parameter(Mandatory = $true)][string]$SourcePath,
        [Parameter(Mandatory = $true)][pscustomobject]$Config,
        [Parameter(Mandatory = $true)][bool]$IsRemote
    )

    $env:RESTIC_PASSWORD = $Config.Password
    $snapshotArgs = @('-r', $Repository, 'snapshots')
    $snapshotResult = Invoke-Restic -Arguments $snapshotArgs -Operation 'repository check'

    if ($snapshotResult -eq 10) {
        $initArgs = @('-r', $Repository, 'init')
        $initResult = Invoke-Restic -Arguments $initArgs -Operation 'repository initialization'
        if ($initResult -ne 0) {
            throw "Unable to initialize repository '$Repository'."
        }
    }
    elseif ($snapshotResult -ne 0) {
        throw "Cannot access repository (exit code $snapshotResult); initialization skipped."
    }

    $unlockArgs = @('-r', $Repository, 'unlock')
    $unlockResult = Invoke-Restic -Arguments $unlockArgs -Operation 'unlock stale locks'
    if ($unlockResult -ne 0) {
        throw "Unable to unlock repository '$Repository'."
    }

    $backupArgs = @(
        '-r', $Repository,
        'backup', $SourcePath,
        '--use-fs-snapshot',
        '--host', $Config.User,
        '--tag', "plan:$($Config.User)",
        '--tag', 'created-by:kzvs-back'
    )
    if ($IsRemote) {
        $backupArgs += @('--limit-upload', [string]$Config.UploadLimitKbps)
    }
    if($Config.RetentionMode -eq 'Cycles' -and -not $TestRun) {
        $snapshots=@(Read-RepositoryCycleSnapshots $Repository $Config)
        $backupArgs+=@(Get-NextBackupCycle $snapshots $Config)
    }
    if ($TestRun) { $backupArgs += @('--json', '--verbose=2') }

    $backupJson = $null
    if ($IsRemote -and -not $TestRun) {
        $script:BackupStatus.backup = 'running'; $script:BackupStatus.verification = 'pending'; $script:BackupStatus.cleanup = 'pending'; Save-BackupStatus
        $backupArgs += '--json'
        $backupJson = Join-Path $env:TEMP ('restic-backup-' + [guid]::NewGuid().ToString('N') + '.json')
    }
    try {
        $backupResult = Invoke-Restic -Arguments $backupArgs -Operation 'backup' -JsonOutputPath $backupJson
        if ($IsRemote -and -not $TestRun) {
            $script:BackupStatus.backup_exit_code = [int]$backupResult
            if ($backupResult -ne 0) { $script:BackupStatus.backup = if ($backupResult -eq 3) { 'partial' } else { 'failed' }; Save-BackupStatus }
            else {
                $script:BackupStatus.backup = 'success'; $script:BackupStatus.verification = 'running'; Save-BackupStatus
                $summary = @(Get-Content -LiteralPath $backupJson -Encoding UTF8 | ForEach-Object { try { $_ | ConvertFrom-Json } catch { } } | Where-Object { (Get-ResticField $_ 'message_type' '') -eq 'summary' })
                if ($summary.Count -ne 1 -or [string]$summary[0].snapshot_id -notmatch '^[0-9a-fA-F]{8,64}$') { throw 'Backup completed but a unique snapshot ID was not available.' }
                $expectedTags = @()
                for ($i = 0; $i -lt ($backupArgs.Count - 1); $i++) { if ($backupArgs[$i] -eq '--tag') { $expectedTags += [string]$backupArgs[$i + 1] } }
                Confirm-RemoteSnapshot -Repository $Repository -Config $Config -SourcePath $SourcePath -SnapshotId ([string]$summary[0].snapshot_id) -ExpectedTags $expectedTags
            }
        }
    } catch {
        if ($IsRemote -and -not $TestRun) {
            if ($script:BackupStatus.backup -eq 'running') { $script:BackupStatus.backup = 'failed' }
            elseif ($script:BackupStatus.verification -eq 'running') { $script:BackupStatus.verification = 'failed' }
            Save-BackupStatus
        }
        throw
    } finally { if ($backupJson -and (Test-Path -LiteralPath $backupJson)) { Remove-Item -LiteralPath $backupJson -Force -ErrorAction SilentlyContinue } }
    if ($backupResult -ne 0) {
        throw "Backup failed for repository '$Repository'."
    }

    if ($TestRun) {
        Write-Log -Level Info -Message 'Test backup successful; retention skipped.'
        return
    }
    if ($IsRemote -and -not $TestRun) { $script:BackupStatus.cleanup = 'running'; Save-BackupStatus }
    try {
    if($Config.RetentionMode -eq 'Cycles') {
        $snapshots=@(Read-RepositoryCycleSnapshots $Repository $Config)
        $expired=@(Get-ExpiredCycleSnapshots $snapshots $Config)
        foreach($id in $expired) {
            $result=Invoke-Restic -Arguments @('-r',$Repository,'forget',$id) -Operation 'remove expired cycle snapshot'
            if($result -ne 0){throw 'Unable to remove expired cycle; cleanup stopped.'}
        }
        # Always retry prune, including after an interrupted previous cleanup.
        $result=Invoke-Restic -Arguments @('-r',$Repository,'prune') -Operation 'prune expired cycle data'
        if($result -ne 0){throw 'Unable to prune expired backup data.'}
        if ($IsRemote -and -not $TestRun) { $script:BackupStatus.cleanup = 'success'; Save-BackupStatus }
        return
    }
    $forgetArgs = @('-r', $Repository, 'forget', '--host', $Config.User, '--tag', "plan:$($Config.User)")
    $forgetArgs += @(Get-RetentionArguments $Config)
    $forgetArgs += '--prune'
    $forgetResult = Invoke-Restic -Arguments $forgetArgs -Operation 'repository retention'
    if ($forgetResult -ne 0) {
        throw "Repository retention failed for '$Repository'."
    }
    if ($IsRemote -and -not $TestRun) { $script:BackupStatus.cleanup = 'success'; Save-BackupStatus }
    } catch {
        if ($IsRemote -and -not $TestRun) { $script:BackupStatus.cleanup = 'failed'; Save-BackupStatus }
        throw
    }
}

function Invoke-RemoteBackupWithRetry {
    param($Repository, $SourcePath, $Config, [int]$MaxAttempts = 4, [int]$DelaySeconds = 1800)
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        $statusVariable = Get-Variable -Name BackupStatus -Scope Script -ErrorAction SilentlyContinue
        $track = -not $TestRun -and $null -ne $statusVariable -and $null -ne $statusVariable.Value
        if ($track) { $script:BackupStatus.backup = 'running'; $script:BackupStatus.backup_exit_code = -1; $script:BackupStatus.verification = 'pending'; $script:BackupStatus.cleanup = 'pending'; Save-BackupStatus }
        Write-Log -Level Info -Message "Remote backup attempt $attempt of $MaxAttempts started."
        try {
            Invoke-RepositoryBackup -Repository $Repository -SourcePath $SourcePath -Config $Config -IsRemote $true
            Write-Log -Level Info -Message "Remote backup attempt $attempt of $MaxAttempts completed successfully."
            return
        }
        catch {
            if ($track) {
                if ($script:BackupStatus.backup -eq 'running') { $script:BackupStatus.backup = 'failed' }
                if ($script:BackupStatus.verification -eq 'running') { $script:BackupStatus.verification = 'failed' }
                if ($script:BackupStatus.cleanup -eq 'failed' -and $script:BackupStatus.verification -eq 'success') {
                    Save-BackupStatus
                    Write-Log -Level Error -Message 'Remote snapshot was confirmed, but retention failed; backup will not be repeated in this run.'
                    throw
                }
                if ($script:BackupStatus.cleanup -eq 'running') { $script:BackupStatus.cleanup = 'failed' }
                Save-BackupStatus
            }
            $reason = $_.Exception.Message
            Write-Log -Level Error -Message "Remote backup attempt $attempt of $MaxAttempts failed: $reason"
            if ($attempt -eq $MaxAttempts) { throw }
            $next = (Get-Date).AddSeconds($DelaySeconds).ToString('yyyy-MM-dd HH:mm:ss')
            Write-Log -Level Info -Message "Remote backup retry scheduled after $DelaySeconds seconds (approximately $next); computer must remain on."
            Start-Sleep -Seconds $DelaySeconds
        }
    }
}

try {
    foreach ($logPath in @($script:InfoLogPath, $script:ErrorLogPath)) {
        if (-not (Test-Path -LiteralPath $logPath)) {
            [System.IO.File]::WriteAllText($logPath, '', $script:Utf8NoBom)
        }
    }

    if (-not (Test-Path -LiteralPath $script:ConfigPath -PathType Leaf)) {
        throw "Configuration file was not found: $script:ConfigPath"
    }
    if (-not (Test-Path -LiteralPath $script:ResticPath -PathType Leaf)) {
        throw "Restic executable was not found: $script:ResticPath"
    }

    $config = Get-Content -LiteralPath $script:ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if($null -ne $config.PSObject.Properties['Mail']){$script:ReportSettings=$config.Mail}
    if($null -ne $config.PSObject.Properties['User']){$script:ReportPoint=[string]$config.User}
    $config = Initialize-TuningSettings $config
    Assert-TuningSettings $config
    if ($config.User -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$' -or $config.User.EndsWith('.')) {
        throw 'Invalid pharmacy user name.'
    }
    $script:RunMutex = New-Object System.Threading.Mutex($false, ('Global\ResticBackup_' + $config.User))
    try { $script:OwnsMutex = $script:RunMutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $script:OwnsMutex = $true }
    if (-not $script:OwnsMutex) {
        throw 'Another backup for this pharmacy is already running.'
    }
    Initialize-BackupStatus
    foreach ($property in @('User', 'Password', 'SourcePath', 'UploadLimitKbps', 'MinFreeHddGb')) {
        if ($null -eq $config.PSObject.Properties[$property] -or
            [string]::IsNullOrWhiteSpace([string]$config.$property)) {
            throw "Configuration property '$property' is missing or empty."
        }
    }

    if (-not (Test-Path -LiteralPath $config.SourcePath)) {
        throw "Backup source path does not exist: $($config.SourcePath)"
    }

    Assert-StorageConfig $config

    if ([int]$config.UploadLimitKbps -lt 1 -or [int]$config.MinFreeHddGb -lt 1) {
        throw 'UploadLimitKbps and MinFreeHddGb must be positive integers.'
    }

    Write-Log -Level Info -Message "Backup run started for host '$($config.User)'."

    try {
        $eligibleDisks = @(
            Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType = 3' -ErrorAction Stop |
                Where-Object {
                    $_.DeviceID -ne $env:SystemDrive -and
                    $_.FreeSpace -ge ([int64]$config.MinFreeHddGb * 1GB)
                } |
                Sort-Object -Property FreeSpace -Descending
        )

        if ($eligibleDisks.Count -gt 0) {
            $localRepository = Join-Path (Join-Path $eligibleDisks[0].DeviceID 'ResticBackup') $config.User
            Write-Log -Level Info -Message "Found eligible local disk '$($eligibleDisks[0].DeviceID)'."
            try {
                Invoke-RepositoryBackup -Repository $localRepository -SourcePath $config.SourcePath -Config $config -IsRemote $false
            }
            catch {
                Write-Log -Level Error -Message "Local backup failed: $($_.Exception.Message)"
                $script:LocalBackupFailed = $true
            }
        }
        else {
            Write-Log -Level Info -Message 'No additional fixed disk meets the configured free-space threshold; local backup skipped.'
        }
    }
    catch {
        Write-Log -Level Error -Message "Unable to inspect local disks: $($_.Exception.Message)"
        $script:LocalBackupFailed = $true
    }

    Set-StorageEnvironment $config
    $remoteRepository = Get-RemoteRepository $config

    try {
        if ($TestRun) {
            Invoke-RemoteBackupWithRetry -Repository $remoteRepository -SourcePath $config.SourcePath -Config $config -MaxAttempts 1
        } else {
            Invoke-RemoteBackupWithRetry -Repository $remoteRepository -SourcePath $config.SourcePath -Config $config
        }
    }
    catch {
        Write-Log -Level Error -Message "Remote backup failed: $($_.Exception.Message)"
        $script:RemoteBackupFailed = $true
    }

    if ($script:LocalBackupFailed -or $script:RemoteBackupFailed) {
        throw 'One or more backup targets failed.'
    }

    Write-Log -Level Info -Message 'Backup run completed successfully.'
    $script:BackupExitCode = 0
    exit 0
}
catch {
    $script:BackupFailure = $_.Exception.Message
    if ($script:OwnsMutex -and -not $TestRun -and $null -ne $script:BackupStatus) {
        if ($script:BackupStatus.backup -in @('pending','running')) { $script:BackupStatus.backup = 'failed' }
        if ($script:BackupStatus.verification -eq 'running') { $script:BackupStatus.verification = 'failed' }
        if ($script:BackupStatus.cleanup -eq 'running') { $script:BackupStatus.cleanup = 'failed' }
        Save-BackupStatus
    }
    try {
        Write-Log -Level Error -Message "Backup run failed: $($_.Exception.Message)"
    }
    catch {
        [Console]::Error.WriteLine(('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $_.Exception.Message))
    }
    exit 1
}
finally {
    if ($script:OwnsMutex -and -not $TestRun -and $null -ne $script:BackupStatus) { $script:BackupStatus.completed_utc = [DateTime]::UtcNow.ToString('o'); Save-BackupStatus }
    if ($script:OwnsMutex) { $script:RunMutex.ReleaseMutex() }
    if ($null -ne $script:RunMutex) { $script:RunMutex.Dispose() }
    Clear-StorageEnvironment
    try {
        Send-ResticMail -Settings $script:ReportSettings -Point $script:ReportPoint -Computer $env:COMPUTERNAME -ExitCode $script:BackupExitCode -Started $script:BackupStarted -Failure $script:BackupFailure -ErrorLogPath $script:ErrorLogPath
    }
    catch { try{Write-Log -Level Error -Message 'SMTP-отчёт не отправлен. Результат бэкапа сохранён.'}catch{} }
}
