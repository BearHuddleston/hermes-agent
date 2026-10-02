/** A QR code for *payload* as a PNG data URL. Lazy: the encoder only loads while a code is on screen. */
export async function renderQrDataUrl(payload: string, width: number): Promise<string> {
  const QRCode = await import('qrcode')

  return QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', margin: 1, width })
}
