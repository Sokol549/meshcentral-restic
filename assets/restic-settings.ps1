function Initialize-TuningSettings {
    param($Config)
    $defaults = @{ UploadLimitMode='Auto'; UploadLimitPercent=50; SpeedTestSeconds=20; SpeedTestMaxMiB=128; RetentionMode='Legacy'; RetentionFullCount=3; RetentionIncrementalCount=6 }
    foreach ($key in $defaults.Keys) {
        if ($null -eq $Config.PSObject.Properties[$key]) { $Config | Add-Member -NotePropertyName $key -NotePropertyValue $defaults[$key] }
    }
    return $Config
}

function Assert-TuningSettings {
    param($Config)
    if($Config.PSObject.Properties['RetentionMode']) {
        if($Config.RetentionMode -notin @('Legacy','Cycles')){throw 'Unknown retention mode.'}
        if($Config.RetentionMode -eq 'Cycles') {
            foreach($key in @('RetentionFullCount','RetentionIncrementalCount')) {
                $value=0;$minimum=if($key -eq 'RetentionFullCount'){1}else{0}
                if(-not [int]::TryParse([string]$Config.$key,[ref]$value) -or $value -lt $minimum -or $value -gt 100000){throw ('Invalid cycle setting: '+$key)}
            }
        }
    }
    if ($Config.UploadLimitMode -notin @('Auto','Manual')) { throw 'UploadLimitMode must be Auto or Manual.' }
    $ranges = @{ UploadLimitKbps=@(1,1048576); MinFreeHddGb=@(1,100000); UploadLimitPercent=@(1,100); SpeedTestSeconds=@(5,60); SpeedTestMaxMiB=@(8,1024) }
    foreach ($key in $ranges.Keys) {
        $value=0
        if (-not [int]::TryParse([string]$Config.$key,[ref]$value) -or $value -lt $ranges[$key][0] -or $value -gt $ranges[$key][1]) {
            throw ('{0}: требуется целое число от {1} до {2}.' -f $key,$ranges[$key][0],$ranges[$key][1])
        }
    }
}

function Get-RetentionArguments($Config) {
    $Config=Initialize-TuningSettings $Config
    Assert-TuningSettings $Config
    if($Config.RetentionMode -eq 'Cycles'){throw 'Cycle retention requires explicit snapshot selection.'}
    return @('--keep-daily','7','--keep-weekly','4')
}

function Get-RetentionCycles($Snapshots,[string]$User) {
    $groups=@{}
    foreach($snapshot in @($Snapshots)) {
        if($snapshot.hostname -ne $User -or @($snapshot.tags) -notcontains "plan:$User"){continue}
        if($snapshot.id -notmatch '^[a-f0-9]{64}$'){throw 'Invalid snapshot ID; retention stopped.'}
        $tags=@($snapshot.tags | Where-Object {$_ -like 'cycle:*'})
        if($tags.Count -gt 1){throw 'Ambiguous backup cycle; retention stopped.'}
        $key=if($tags.Count){[string]$tags[0]}else{'legacy'}
        if($key -ne 'legacy' -and $key -notmatch '^cycle:[a-f0-9]{32}$'){throw 'Invalid backup cycle tag.'}
        if(-not $groups.ContainsKey($key)){$groups[$key]=New-Object 'System.Collections.Generic.List[object]'}
        $groups[$key].Add($snapshot)
    }
    foreach($key in $groups.Keys) {
        $items=@($groups[$key]|Sort-Object {[DateTimeOffset]$_.time})
        if($key -ne 'legacy' -and @($items|Where-Object {@($_.tags) -contains 'backup-kind:full'}).Count -ne 1){throw 'Cycle has no unique full point; retention stopped.'}
        [pscustomobject]@{Key=$key;Snapshots=$items;Time=[DateTimeOffset]$items[0].time}
    }
}

function Get-NextBackupCycle($Snapshots,$Config) {
    $cycles=@(Get-RetentionCycles $Snapshots $Config.User|Sort-Object Time -Descending)
    if($cycles.Count -and $cycles[0].Key -ne 'legacy' -and $cycles[0].Snapshots.Count -le [int]$Config.RetentionIncrementalCount) {
        return @('--tag',$cycles[0].Key,'--tag','backup-kind:incremental')
    }
    return @('--tag',('cycle:'+([guid]::NewGuid().ToString('N'))),'--tag','backup-kind:full')
}

function Get-ExpiredCycleSnapshots($Snapshots,$Config) {
    $cycles=@(Get-RetentionCycles $Snapshots $Config.User|Sort-Object Time -Descending)
    foreach($cycle in @($cycles|Select-Object -Skip ([int]$Config.RetentionFullCount))) {
        # Delete the full marker last, so interrupted cleanup leaves a valid cycle.
        foreach($snapshot in $cycle.Snapshots|Sort-Object {@($_.tags) -contains 'backup-kind:full'}){$snapshot.id}
    }
}

function New-RetentionDialog([string]$Mode,[int]$FullCount=3,[int]$IncrementalCount=6) {
    $dialog=New-Object Windows.Forms.Form
    $dialog.Text='Хранение резервных копий';$dialog.ClientSize=New-Object Drawing.Size(530,355)
    $dialog.StartPosition='CenterParent';$dialog.FormBorderStyle='FixedDialog';$dialog.MaximizeBox=$false;$dialog.MinimizeBox=$false
    $note=New-Object Windows.Forms.Label
    $note.Text='Цикл: полная точка, затем M инкрементных запусков. Хранятся N последних циклов, включая текущий. В restic каждый снимок восстанавливает всю базу; данные хранятся с дедупликацией.'
    $note.Location=New-Object Drawing.Point(16,16);$note.Size=New-Object Drawing.Size(495,65);$dialog.Controls.Add($note)
    $picker=New-Object Windows.Forms.ComboBox
    $picker.DropDownStyle='DropDownList';$picker.Location=New-Object Drawing.Point(16,88);$picker.Size=New-Object Drawing.Size(495,25)
    [void]$picker.Items.Add('Хранить N циклов: полная + M инкрементных')
    [void]$picker.Items.Add('Прежняя политика: 7 дней + 4 недели')
    $picker.SelectedIndex=if($Mode -eq 'Legacy'){1}else{0};$dialog.Controls.Add($picker)
    $label=New-Object Windows.Forms.Label
    $label.Text='Полных точек / циклов хранить (N):';$label.Location=New-Object Drawing.Point(16,132);$label.Size=New-Object Drawing.Size(310,25);$dialog.Controls.Add($label)
    $number=New-Object Windows.Forms.NumericUpDown
    $number.Minimum=1;$number.Maximum=100000;$number.Value=$FullCount
    $number.Location=New-Object Drawing.Point(340,130);$number.Size=New-Object Drawing.Size(170,25);$number.Enabled=($picker.SelectedIndex -eq 0);$dialog.Controls.Add($number)
    $incremental=New-Object Windows.Forms.NumericUpDown
    $incremental.Minimum=0;$incremental.Maximum=100000;$incremental.Value=$IncrementalCount
    $incremental.Location=New-Object Drawing.Point(340,170);$incremental.Size=New-Object Drawing.Size(170,25);$incremental.Enabled=($picker.SelectedIndex -eq 0);$dialog.Controls.Add($incremental)
    $incLabel=New-Object Windows.Forms.Label
    $incLabel.Text='Инкрементных между полными (M):';$incLabel.Location=New-Object Drawing.Point(16,172);$incLabel.Size=New-Object Drawing.Size(310,25);$dialog.Controls.Add($incLabel)
    $picker.Tag=@($number,$incremental)
    $picker.Add_SelectedIndexChanged({foreach($control in $this.Tag){$control.Enabled=($this.SelectedIndex -eq 0)}})
    $details=New-Object Windows.Forms.Label
    $details.Text='Настройка попадёт в новый EXE. После успешного обычного бэкапа лишние снимки удаляются, неиспользуемые данные очищаются. Политика применяется отдельно к локальному и удалённому хранилищам.'
    $details.Location=New-Object Drawing.Point(16,215);$details.Size=New-Object Drawing.Size(495,75);$dialog.Controls.Add($details)
    $save=New-Object Windows.Forms.Button
    $save.Text='Сохранить';$save.Location=New-Object Drawing.Point(275,310);$save.Size=New-Object Drawing.Size(115,30)
    $save.Tag=[pscustomobject]@{Form=$dialog;Picker=$picker;Number=$number;Incremental=$incremental}
    $save.Add_Click({
        $state=$this.Tag
        $state.Form.Tag=[pscustomobject]@{Mode=$(if($state.Picker.SelectedIndex -eq 0){'Cycles'}else{'Legacy'});FullCount=[int]$state.Number.Value;IncrementalCount=[int]$state.Incremental.Value}
        $state.Form.DialogResult=[Windows.Forms.DialogResult]::OK
    })
    $dialog.Controls.Add($save);$dialog.AcceptButton=$save
    $cancel=New-Object Windows.Forms.Button
    $cancel.Text='Отмена';$cancel.Location=New-Object Drawing.Point(400,310);$cancel.Size=New-Object Drawing.Size(110,30);$cancel.DialogResult=[Windows.Forms.DialogResult]::Cancel
    $dialog.Controls.Add($cancel);$dialog.CancelButton=$cancel
    return [pscustomobject]@{Form=$dialog;Mode=$picker;Count=$number;Incremental=$incremental;SaveButton=$save}
}

function Save-ResticConfig {
    param([string]$Path, $Config)
    Assert-TuningSettings $Config
    $temporary=Join-Path (Split-Path -Parent $Path) ('.config-'+[guid]::NewGuid().ToString('N')+'.tmp')
    try {
        [IO.File]::WriteAllText($temporary,($Config|ConvertTo-Json -Depth 8),(New-Object Text.UTF8Encoding($false)))
        if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temporary,$Path,($Path+'.previous')) }
        else { [IO.File]::Move($temporary,$Path) }
    }
    finally { if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary -Force} }
}

function Invoke-LocalSettings {
    param([string]$Directory)
    $path=Join-Path $Directory 'config.json'
    if(-not(Test-Path -LiteralPath $path)){throw 'Сначала выполните инициализацию точки.'}
    while($true) {
        $config=Initialize-TuningSettings (Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json)
        Assert-TuningSettings $config
        Write-Host "`nНастройки точки: $($config.User)"
        Write-Host ('Лимит: {0} KiB/s; режим: {1}; доля замера: {2}%; цель: {3} с; максимум: {4} MiB; свободное место: {5} GiB' -f $config.UploadLimitKbps,$config.UploadLimitMode,$config.UploadLimitPercent,$config.SpeedTestSeconds,$config.SpeedTestMaxMiB,$config.MinFreeHddGb)
        Write-Host '1. Установить лимит вручную (KiB/s)'
        Write-Host '2. Доля измеренной скорости (%)'
        Write-Host '3. Целевая длительность замера (5–60 с)'
        Write-Host '4. Максимальный объём замера (8–1024 MiB)'
        Write-Host '5. Минимум свободного места локального диска (GiB)'
        Write-Host '6. Повторно измерить скорость и применить лимит'
        Write-Host ('7. Хранение бэкапов: '+$(if($config.RetentionMode -eq 'Cycles'){('{0} полных циклов, по {1} инкрементных' -f $config.RetentionFullCount,$config.RetentionIncrementalCount)}else{'7 дней + 4 недели'}))
        Write-Host '0. Назад'
        $choice=Read-Host 'Выберите настройку'
        if($null -eq $choice -or $choice -eq '0'){return}
        if($choice -eq '7') {
            $answer=Read-Host 'Количество полных точек / циклов (1–100000), legacy — 7 дней + 4 недели, пусто — отмена'
            if([string]::IsNullOrWhiteSpace($answer)){continue}
            if($answer -eq 'legacy'){$config.RetentionMode='Legacy'}
            else {
                $count=0
                if(-not [int]::TryParse($answer,[ref]$count) -or $count -lt 1 -or $count -gt 100000){Write-Host 'Требуется целое число от 1 до 100000.';continue}
                $incremental=0
                $incAnswer=Read-Host 'Инкрементных запусков между полными (0–100000)'
                if(-not [int]::TryParse($incAnswer,[ref]$incremental) -or $incremental -lt 0 -or $incremental -gt 100000){Write-Host 'Требуется целое число от 0 до 100000.';continue}
                $config.RetentionMode='Cycles';$config.RetentionFullCount=$count;$config.RetentionIncrementalCount=$incremental
            }
            try {Save-ResticConfig $path $config;Write-Host 'Сохранено. Удаление старых копий выполнится после следующего успешного обычного бэкапа.'}
            catch {Write-Host ('Настройка не сохранена: '+$_.Exception.Message)}
            continue
        }
        if($choice -eq '6') {
            $powerShell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
            & $powerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $Directory 'deploy-restic.ps1') -ConfigPath $path -DestinationPath $Directory -MeasureOnly
            if($LASTEXITCODE -ne 0){throw "Повторный замер не выполнен (код $LASTEXITCODE). Прежний лимит сохранён."}
            continue
        }
        $key=switch($choice){'1'{'UploadLimitKbps'} '2'{'UploadLimitPercent'} '3'{'SpeedTestSeconds'} '4'{'SpeedTestMaxMiB'} '5'{'MinFreeHddGb'} default{$null}}
        if($null -eq $key){Write-Host 'Введите номер от 0 до 7.';continue}
        $answer=Read-Host 'Новое значение (пусто — отмена)'
        if([string]::IsNullOrWhiteSpace($answer)){continue}
        $number=0
        if(-not [int]::TryParse($answer,[ref]$number)){Write-Host 'Требуется целое число.';continue}
        $config.$key=$number
        if($choice -eq '1'){$config.UploadLimitMode='Manual'}
        if($choice -eq '2' -and $null -ne $config.PSObject.Properties['MeasuredUploadKibPerSecond']) {
            $config.UploadLimitKbps=[Math]::Max(1,[int][Math]::Floor([double]$config.MeasuredUploadKibPerSecond*$number/100))
            $config.UploadLimitMode='Auto'
        }
        try { Save-ResticConfig -Path $path -Config $config; Write-Host 'Сохранено. Применится к следующим запускам. Текущий бэкап и расписание не изменены.' }
        catch { Write-Host ('Настройка не сохранена: '+$_.Exception.Message) }
    }
}
function Find-OneCDDatabaseFiles {
    param([string]$Root='C:\')
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { throw "Папка для поиска недоступна: $Root" }
    $pending=New-Object 'System.Collections.Generic.Stack[string]'
    $matches=New-Object 'System.Collections.Generic.List[string]'
    $pending.Push([IO.Path]::GetFullPath($Root))
    while($pending.Count -gt 0) {
        $directory=$pending.Pop()
        try {
            foreach($file in [IO.Directory]::GetFiles($directory,'1Cv8.1CD',[IO.SearchOption]::TopDirectoryOnly)) {
                try {if(-not (([IO.File]::GetAttributes($file) -band [IO.FileAttributes]::ReparsePoint) -ne 0)){$matches.Add($file)}} catch [System.IO.IOException] {} catch [System.UnauthorizedAccessException] {}
            }
        } catch [System.IO.IOException] {} catch [System.UnauthorizedAccessException] {} catch [System.Security.SecurityException] {}
        try {
            foreach($child in [IO.Directory]::GetDirectories($directory)) {
                try {if(-not (([IO.File]::GetAttributes($child) -band [IO.FileAttributes]::ReparsePoint) -ne 0)){$pending.Push($child)}} catch [System.IO.IOException] {} catch [System.UnauthorizedAccessException] {}
            }
        } catch [System.IO.IOException] {} catch [System.UnauthorizedAccessException] {} catch [System.Security.SecurityException] {}
    }
    return @($matches | Sort-Object -Unique)
}

function Resolve-OneCDSourcePath {
    param([Parameter(Mandatory=$true)][string]$ConfiguredPath,[string]$Root='C:\',[switch]$AllowPrompt)
    if(Test-Path -LiteralPath $ConfiguredPath -PathType Leaf) { return [IO.Path]::GetFullPath($ConfiguredPath) }
    Write-Host "Файл базы по указанному пути не найден: $ConfiguredPath"
    Write-Host "Поиск файла 1Cv8.1CD на диске $Root. Это может занять несколько минут..."
    $found=@(Find-OneCDDatabaseFiles -Root $Root)
    if($found.Count -eq 0){throw "Файл 1Cv8.1CD не найден. Укажите путь к действующей базе в генераторе и создайте EXE заново."}
    if($found.Count -eq 1){Write-Host "Найдена база: $($found[0])";return $found[0]}
    Write-Host 'Найдено несколько баз. Укажите именно рабочую базу аптеки:'
    for($i=0;$i -lt $found.Count;$i++){Write-Host ('{0}. {1}' -f ($i+1),$found[$i])}
    if(-not $AllowPrompt){throw 'Автоматический выбор невозможен: найдено несколько баз. Запустите EXE без параметров и выберите базу в меню.'}
    $answer=Read-Host 'Номер базы (0 — отмена)'
    $number=0
    if(-not [int]::TryParse($answer,[ref]$number) -or $number -lt 1 -or $number -gt $found.Count){throw 'Выбор базы отменён или указан неверный номер. Установка/тест не выполнены.'}
    return $found[$number-1]
}
