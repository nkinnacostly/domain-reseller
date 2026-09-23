/**
 * Type declarations for `nodejs-dna` v3, which ships none.
 *
 * Derived from the official SDK README and source:
 * https://github.com/domainreseller/nodejs-dna
 *
 * Keep this in sync when the SDK is upgraded. Anything not declared here is a
 * method we have not reviewed — add it deliberately, do not widen to `any`.
 */
declare module 'nodejs-dna' {
  export type DnaOptions = {
    /** true → REST OTE sandbox (ote.domainresellerapi.com) */
    testMode?: boolean
    /** MUST be false. See CLAUDE.md N2 / PRD SEC-14. */
    telemetry?: boolean
    sentryDsn?: string
  }

  export type DnaError = { Code: string; Message: string; Details?: string }
  export type DnaOk<T> = { result: 'OK'; data: T }
  export type DnaFail = { result: 'ERROR'; error: DnaError }
  export type DnaResult<T> = DnaOk<T> | DnaFail

  export type DnaContact = {
    FirstName: string
    LastName: string
    Company?: string
    EMail: string
    AddressLine1: string
    AddressLine2?: string
    AddressLine3?: string
    City: string
    State?: string
    ZipCode: string
    Country: string
    Phone: string
    PhoneCountryCode: string
    Fax?: string
    FaxCountryCode?: string
    Type?: string
  }

  export type DnaContactSet = {
    Registrant: DnaContact
    Administrative: DnaContact
    Technical: DnaContact
    Billing: DnaContact
  }

  /** Observed live 22 Sept 2026: `Price` arrives as a decimal string ("11.3100"). */
  export type DnaAvailability = {
    DomainName: string
    TLD: string
    Status: 'available' | 'notavailable' | string
    Command?: string
    Price?: number | string
    Currency?: string
    Period?: number
    IsFee?: boolean
    ClassKey?: string
    Reason?: string | null
  }

  /**
   * What the REST client's `parseDomainInfo` returns (read from the SDK
   * source, 23 Sept 2026). Booleans arrive as the strings 'true'/'false', and
   * dates as `YYYY-MM-DDTHH:mm:ss` in the gateway's LOCAL time, no zone.
   */
  export type DnaDomain = {
    ID: number
    DomainName: string
    Status: string
    AuthCode?: string
    LockStatus: 'true' | 'false'
    PrivacyProtectionStatus: 'true' | 'false'
    IsChildNameServer: 'true' | 'false'
    Dates: { Start: string; Expiration: string; RemainingDays: number }
    NameServers: string[]
    [key: string]: unknown
  }

  /** The axios-shaped request the REST client hands its transport. */
  export type DnaHttpRequest = {
    method: string
    url: string
    headers: Record<string, string>
    timeout?: number
    params?: Record<string, unknown>
    data?: unknown
  }
  export type DnaHttpResponse = { status: number; data: unknown; headers: Record<string, string> }

  export default class DomainNameApi {
    static readonly VERSION: string
    constructor(userName: string, password: string, options?: DnaOptions | boolean)

    /**
     * The transport-specific client. Not public API: we replace the REST
     * client's `_axios` so TLS is verified and outcomes are recorded
     * (see src/dna/transport.ts). Absent fields mean the SOAP client.
     */
    readonly client: { _axios?: (config: DnaHttpRequest) => Promise<DnaHttpResponse> }

    getActiveTransport(): 'REST' | 'SOAP'
    setErrorReportingEnabled(enabled: boolean): void

    /** Returns a BARE ARRAY on success — not the standard envelope. */
    CheckAvailability(
      domains: string[],
      extensions: string[],
      period?: number,
      command?: string,
    ): Promise<DnaAvailability[] | DnaFail>

    GetTldList(count?: number): Promise<DnaResult<unknown>>
    GetList(extraParameters?: Record<string, unknown>): Promise<DnaResult<{ Domains: DnaDomain[] }>>
    GetDetails(domainName: string): Promise<DnaResult<DnaDomain>>
    SyncFromRegistry(domainName: string): Promise<DnaResult<DnaDomain>>

    RegisterWithContactInfo(
      domainName: string,
      period: number,
      contacts: DnaContactSet,
      nameServers?: string[],
      eppLock?: boolean,
      privacyLock?: boolean,
      additionalAttributes?: Record<string, string> | never[],
    ): Promise<DnaResult<DnaDomain>>

    Renew(domainName: string, period: number): Promise<DnaResult<{ ExpirationDate: string }>>
    ModifyPrivacyProtectionStatus(
      domainName: string,
      status: boolean,
      reason?: string,
    ): Promise<DnaResult<unknown>>

    GetContacts(domainName: string): Promise<DnaResult<{ contacts: DnaContactSet }>>
    SaveContacts(domainName: string, contacts: DnaContactSet): Promise<DnaResult<unknown>>

    ModifyNameServer(
      domainName: string,
      nameServers: string[],
    ): Promise<DnaResult<{ NameServers: string[] }>>
    AddChildNameServer(
      domainName: string,
      nameServer: string,
      ipAddress: string,
    ): Promise<DnaResult<unknown>>
    ModifyChildNameServer(
      domainName: string,
      nameServer: string,
      ipAddress: string,
    ): Promise<DnaResult<unknown>>
    DeleteChildNameServer(domainName: string, nameServer: string): Promise<DnaResult<unknown>>

    Transfer(
      domainName: string,
      eppCode: string,
      period: number,
      contacts?: DnaContactSet | never[],
    ): Promise<DnaResult<DnaDomain>>
    CheckTransfer(domainName: string, authcode: string): Promise<DnaResult<unknown>>
    ApproveTransfer(domainName: string): Promise<DnaResult<{ DomainName: string; Status: string }>>
    CancelTransfer(domainName: string): Promise<DnaResult<{ DomainName: string; Status: string }>>
    RejectTransfer(domainName: string): Promise<DnaResult<{ DomainName: string; Status: string }>>

    EnableTheftProtectionLock(domainName: string): Promise<DnaResult<unknown>>
    DisableTheftProtectionLock(domainName: string): Promise<DnaResult<unknown>>

    GetResellerDetails(): Promise<{
      result: 'OK' | 'ERROR'
      id?: number
      active?: boolean
      name?: string
      balance?: number
      currency?: string
      symbol?: string
      balances?: unknown[]
    }>
    /** Observed live 23 Sept 2026: `Balance` arrives as a decimal string ("0.00"). */
    GetCurrentBalance(currencyId?: string): Promise<{
      OperationResult: 'SUCCESS' | 'FAILED'
      Balance?: number | string
      CurrencyId?: number
      CurrencyName?: string
      CurrencySymbol?: string
    }>

    ValidateContact(contact: Partial<DnaContact>): DnaContact
    IsTrTLD(domain: string): boolean
  }
}
