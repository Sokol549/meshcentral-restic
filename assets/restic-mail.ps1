function Get-MailSettings {
    param($Value)
    $result=[pscustomobject]@{Enabled=$false;Server='';Port=587;UseSsl=$true;Username='';Password='';From='';To='';TimeoutSeconds=15}
    if($null -ne $Value) {
        $source=[pscustomobject]$Value
        foreach($key in @('Enabled','Server','Port','UseSsl','Username','Password','From','To','TimeoutSeconds')) {
            if($null -ne $source.PSObject.Properties[$key]){$result.$key=$source.$key}
        }
    }
    return $result
}

function Assert-MailSettings {
    param($Value)
    $mail=Get-MailSettings $Value
    if($mail.Enabled -isnot [bool]){throw 'Mail.Enabled must be a boolean.'}
    if(-not $mail.Enabled){return}
    if([Uri]::CheckHostName([string]$mail.Server) -eq [UriHostNameType]::Unknown){throw 'Укажите имя SMTP-сервера без протокола и порта.'}
    $port=0;$timeout=0
    if(-not [int]::TryParse([string]$mail.Port,[ref]$port) -or $port -lt 1 -or $port -gt 65535){throw 'Порт SMTP: число от 1 до 65535.'}
    if(-not [int]::TryParse([string]$mail.TimeoutSeconds,[ref]$timeout) -or $timeout -lt 1 -or $timeout -gt 60){throw 'Таймаут SMTP: от 1 до 60 секунд.'}
    if($mail.UseSsl -isnot [bool]){throw 'Mail.UseSsl must be a boolean.'}
    foreach($key in @('From','To')) {
        if([string]::IsNullOrWhiteSpace([string]$mail.$key) -or [string]$mail.$key -match '[\r\n]'){throw "Укажите корректный адрес $key."}
        try{[void](New-Object Net.Mail.MailAddress([string]$mail.$key))}catch{throw "Некорректный адрес $key."}
    }
}

function Send-ResticMail {
    param($Settings,[string]$Point,[string]$Computer,[int]$ExitCode,[datetime]$Started,[string]$Failure,[string]$ErrorLogPath)
    $mail=Get-MailSettings $Settings
    if(-not $mail.Enabled){return}
    $client=$null;$message=$null;$previousProtocol=$null
    try {
        Assert-MailSettings $mail
        $finished=Get-Date
        $status=if($ExitCode -eq 0){'🟢 Успех'}else{'🔴 Ошибка'}
        $body="Точка: $Point`r`nКомпьютер: $Computer`r`nСтатус: $status`r`nКод завершения скрипта: $ExitCode`r`nНачало: $($Started.ToString('yyyy-MM-dd HH:mm:ss zzz'))`r`nОкончание: $($finished.ToString('yyyy-MM-dd HH:mm:ss zzz'))`r`nПродолжительность: $($finished-$Started)"
        if($ExitCode -ne 0) {
            $body+="`r`n`r`nПричина: $Failure"
            if($ErrorLogPath -and (Test-Path -LiteralPath $ErrorLogPath)) {
                $tail=@(Get-Content -LiteralPath $ErrorLogPath -Encoding UTF8 -Tail 20)
                $body+="`r`n`r`nПоследние строки журнала ошибок (могут включать предыдущие запуски):`r`n"+($tail -join "`r`n")
            }
        }
        $message=New-Object Net.Mail.MailMessage
        $message.From=[string]$mail.From
        [void]$message.To.Add([string]$mail.To)
        $message.Subject="[Restic] $Point — $status"
        $message.SubjectEncoding=[Text.Encoding]::UTF8
        $message.BodyEncoding=[Text.Encoding]::UTF8
        $message.Body=$body
        $client=New-Object Net.Mail.SmtpClient([string]$mail.Server,[int]$mail.Port)
        $client.EnableSsl=[bool]$mail.UseSsl
        $client.UseDefaultCredentials=$false
        $client.Timeout=[int]$mail.TimeoutSeconds*1000
        if(-not [string]::IsNullOrWhiteSpace([string]$mail.Username)){$client.Credentials=New-Object Net.NetworkCredential([string]$mail.Username,[string]$mail.Password)}
        if($mail.UseSsl) {
            $previousProtocol=[Net.ServicePointManager]::SecurityProtocol
            [Net.ServicePointManager]::SecurityProtocol=$previousProtocol -bor [Net.SecurityProtocolType]::Tls12
        }
        $client.Send($message)
        Write-Log -Level Info -Message 'SMTP-отчёт отправлен.'
    }
    catch {
        # A mail failure must never replace the backup's exit code.
        try{Write-Log -Level Error -Message ('Не удалось отправить SMTP-отчёт: '+$_.Exception.Message+' Причина: '+$_.Exception.GetBaseException().Message)}catch{}
    }
    finally {
        try{if($null -ne $message){$message.Dispose()}}catch{}
        try{if($null -ne $client){$client.Dispose()}}catch{}
        try{if($null -ne $previousProtocol){[Net.ServicePointManager]::SecurityProtocol=$previousProtocol}}catch{}
    }
}
