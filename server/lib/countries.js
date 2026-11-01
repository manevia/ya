'use strict';
/*
 * Country starting points for Settings › Country & language. They are PRESETS, not facts the app relies on:
 * mobile-money products and number lengths change, so check each value locally and edit after applying.
 * Fields: code, name, dialling prefix, significant phone digits, IANA time zone, default language,
 * currencies (first = usual billing currency), currency symbols, mobile-money providers, word for a region.
 */
const P = (code, name, prefix, digits, timezone, language, currencies, symbols, providers, region) => ({ code, name, phone_prefix: prefix, phone_digits: digits, timezone, default_language: language, currencies, currency_symbols: symbols, momo_providers: providers, region_label: region });
const PRESETS = [
  P('LR', 'Liberia', '+231', 9, 'Africa/Monrovia', 'en', 'USD,LRD', 'USD=US$;LRD=L$', 'mtn=MTN MoMo;orange=Orange Money', 'County'),
  P('SL', 'Sierra Leone', '+232', 8, 'Africa/Freetown', 'en', 'SLE,USD', 'SLE=Le;USD=US$', 'orange=Orange Money;afrimoney=Afrimoney', 'District'),
  P('GN', 'Guinea', '+224', 9, 'Africa/Conakry', 'fr', 'GNF', 'GNF=FG', 'orange=Orange Money;mtn=MTN MoMo', 'Région'),
  P('CI', "Côte d'Ivoire", '+225', 10, 'Africa/Abidjan', 'fr', 'XOF', 'XOF=FCFA', 'orange=Orange Money;mtn=MTN MoMo;moov=Moov Money;wave=Wave', 'Région'),
  P('SN', 'Senegal', '+221', 9, 'Africa/Dakar', 'fr', 'XOF', 'XOF=FCFA', 'wave=Wave;orange=Orange Money', 'Région'),
  P('GW', 'Guinea-Bissau', '+245', 9, 'Africa/Bissau', 'pt', 'XOF', 'XOF=FCFA', 'orange=Orange Money;mtn=MTN MoMo', 'Região'),
  P('CM', 'Cameroon', '+237', 9, 'Africa/Douala', 'fr', 'XAF', 'XAF=FCFA', 'mtn=MTN MoMo;orange=Orange Money', 'Région'),
  P('CD', 'DR Congo', '+243', 9, 'Africa/Kinshasa', 'fr', 'CDF,USD', 'CDF=FC;USD=US$', 'mpesa=M-Pesa;airtel=Airtel Money;orange=Orange Money', 'Province'),
  P('GH', 'Ghana', '+233', 9, 'Africa/Accra', 'en', 'GHS', 'GHS=GH₵', 'mtn=MTN MoMo;telecel=Telecel Cash', 'Region'),
  P('NG', 'Nigeria', '+234', 10, 'Africa/Lagos', 'en', 'NGN', 'NGN=₦', 'opay=OPay;palmpay=PalmPay;moniepoint=Moniepoint', 'State'),
  P('KE', 'Kenya', '+254', 9, 'Africa/Nairobi', 'en', 'KES', 'KES=KSh', 'mpesa=M-Pesa;airtel=Airtel Money', 'County'),
  P('UG', 'Uganda', '+256', 9, 'Africa/Kampala', 'en', 'UGX', 'UGX=USh', 'mtn=MTN MoMo;airtel=Airtel Money', 'District'),
  P('TZ', 'Tanzania', '+255', 9, 'Africa/Dar_es_Salaam', 'en', 'TZS', 'TZS=TSh', 'mpesa=M-Pesa;airtel=Airtel Money', 'Region'),
  P('RW', 'Rwanda', '+250', 9, 'Africa/Kigali', 'en', 'RWF', 'RWF=FRw', 'mtn=MTN MoMo;airtel=Airtel Money', 'District'),
  P('MZ', 'Mozambique', '+258', 9, 'Africa/Maputo', 'pt', 'MZN', 'MZN=MT', 'mpesa=M-Pesa;emola=e-Mola;mkesh=mKesh', 'Província'),
  P('AO', 'Angola', '+244', 9, 'Africa/Luanda', 'pt', 'AOA', 'AOA=Kz', 'unitel=Unitel Money', 'Província')
];
module.exports = { PRESETS };
