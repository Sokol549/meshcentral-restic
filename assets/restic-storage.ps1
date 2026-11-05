function Get-StorageType {
    param($Config)
    if ($null -eq $Config.PSObject.Properties['StorageType']) { return 'Rest' }
    if ($Config.StorageType -notin @('Rest','S3')) { throw 'StorageType must be Rest or S3.' }
    return [string]$Config.StorageType
}

function Assert-StorageConfig {
    param($Config)
    $type = Get-StorageType $Config
    $required = if ($type -eq 'S3') { @('S3Endpoint','S3Region','S3Bucket','S3AccessKeyId','S3SecretAccessKey') } else { @('ServerUrl') }
    foreach ($name in $required) {
        if ($null -eq $Config.PSObject.Properties[$name] -or [string]::IsNullOrWhiteSpace([string]$Config.$name)) {
            throw "Storage field '$name' is required."
        }
    }
    $address = if ($type -eq 'S3') { $Config.S3Endpoint } else { $Config.ServerUrl }
    $uri = [Uri]$address
    if (-not $uri.IsAbsoluteUri -or $uri.Scheme -notin @('https','http') -or $uri.UserInfo -or $uri.Query -or $uri.Fragment) {
        throw 'Storage endpoint must be an absolute HTTP(S) URL without credentials, query or fragment.'
    }
    if ($type -eq 'S3') {
        if ($uri.Scheme -ne 'https' -or $uri.AbsolutePath -ne '/') { throw 'S3 endpoint must be HTTPS without a bucket or path.' }
        if ($Config.S3Bucket -notmatch '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$' -or $Config.S3Bucket -match '\.\.|^\d+\.\d+\.\d+\.\d+$') { throw 'Invalid S3 bucket name.' }
        if ($Config.S3Region -notmatch '^[a-z0-9-]+$') { throw 'Invalid S3 region/pool.' }
        if ($null -ne $Config.PSObject.Properties['S3Prefix'] -and $Config.S3Prefix) {
            if ($Config.S3Prefix -match '[\\?#\x00-\x20]' -or @(([string]$Config.S3Prefix).Split('/') | Where-Object { $_ -in @('.','..') }).Count) {
                throw 'S3 prefix must contain no spaces, backslashes, query characters or relative path segments.'
            }
        }
    }
}

function Get-RemoteRepository {
    param($Config)
    Assert-StorageConfig $Config
    if ((Get-StorageType $Config) -eq 'S3') {
        $prefix = ''
        if ($null -ne $Config.PSObject.Properties['S3Prefix']) { $prefix = ([string]$Config.S3Prefix).Trim('/') }
        if ($prefix) { $prefix += '/' }
        # Each pharmacy has its own repository, even within a shared bucket.
        return 's3:{0}/{1}/{2}{3}' -f $Config.S3Endpoint.TrimEnd('/'), $Config.S3Bucket, $prefix, [Uri]::EscapeDataString($Config.User)
    }
    return 'rest:{0}/{1}/' -f $Config.ServerUrl.TrimEnd('/'), [Uri]::EscapeDataString($Config.User)
}

function Clear-StorageEnvironment {
    foreach ($name in @('RESTIC_PASSWORD','RESTIC_REST_USERNAME','RESTIC_REST_PASSWORD','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN','AWS_DEFAULT_REGION','AWS_PROFILE')) {
        Remove-Item -LiteralPath ('Env:\' + $name) -ErrorAction SilentlyContinue
    }
}

function Set-StorageEnvironment {
    param($Config)
    Clear-StorageEnvironment
    $env:RESTIC_PASSWORD = $Config.Password
    if ((Get-StorageType $Config) -eq 'S3') {
        $env:AWS_ACCESS_KEY_ID = $Config.S3AccessKeyId
        $env:AWS_SECRET_ACCESS_KEY = $Config.S3SecretAccessKey
        $env:AWS_DEFAULT_REGION = $Config.S3Region
    }
    else {
        $env:RESTIC_REST_USERNAME = $Config.User
        $env:RESTIC_REST_PASSWORD = $Config.Password
    }
}

function Get-StorageArguments {
    param($Config)
    if ((Get-StorageType $Config) -eq 'S3') {
        return @('-o', ('s3.region=' + $Config.S3Region), '-o', 's3.bucket-lookup=path')
    }
}
