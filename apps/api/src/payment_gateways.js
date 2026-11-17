import { createHmac, timingSafeEqual } from 'node:crypto';

function equalHex(left,right){
  if(typeof left!=='string'||typeof right!=='string'||!/^[a-f0-9]+$/i.test(left)||!/^[a-f0-9]+$/i.test(right))return false;
  const a=Buffer.from(left,'hex'),b=Buffer.from(right,'hex');
  return a.length===b.length&&timingSafeEqual(a,b);
}

function equalText(left,right){
  if(typeof left!=='string'||typeof right!=='string')return false;
  const a=Buffer.from(left),b=Buffer.from(right);
  return a.length===b.length&&timingSafeEqual(a,b);
}

function currencyMinorUnits(currency){
  const zero=new Set(['BIF','CLP','DJF','GNF','ISK','JPY','KMF','KRW','PYG','RWF','UGX','VND','VUV','XAF','XOF','XPF']);
  const three=new Set(['BHD','IQD','JOD','KWD','LYD','OMR','TND']);
  if(zero.has(currency))return 0;
  if(three.has(currency))return 3;
  return 2;
}

function toMajorUnits(amountMinor,currency){
  const exponent=currencyMinorUnits(currency);
  return Number((amountMinor/Math.pow(10,exponent)).toFixed(exponent));
}

function parseConfiguredCurrencies(envName,defaults){
  const raw=process.env[envName];
  if(!raw)return defaults;
  return new Set(raw.split(',').map(item=>item.trim().toUpperCase()).filter(Boolean));
}

async function requestJson(url,options){
  const response=await fetch(url,options);
  const raw=await response.text();
  let body=null;
  try{body=raw?JSON.parse(raw):null;}catch{throw new Error('Payment gateway returned invalid JSON.');}
  if(!response.ok){
    const message=typeof body?.message==='string'?body.message:'Payment gateway request failed.';
    const error=new Error(message);
    error.code='PAYMENT_GATEWAY_ERROR';
    error.status=response.status;
    throw error;
  }
  return body;
}

class PaystackGateway{
  constructor(){
    this.code='paystack';
    this.secretKey=process.env.PAYSTACK_SECRET_KEY||'';
    this.callbackUrl=process.env.PAYMENT_RETURN_URL||'';
    this.currencies=parseConfiguredCurrencies('PAYSTACK_SUPPORTED_CURRENCIES',['NGN','GHS','ZAR','KES']);
    this.baseUrl=process.env.PAYSTACK_API_BASE_URL||'https://api.paystack.co';
  }

  isConfigured(){return Boolean(this.secretKey&&this.callbackUrl);}
  supportsCurrency(currency){return this.currencies.has(currency.toUpperCase());}

  async initialize(input){
    if(!this.isConfigured())throw new Error('Paystack is not configured for this environment.');
    if(!this.supportsCurrency(input.currencyCode))throw new Error('Paystack is not enabled for this currency in the current market configuration.');
    const data=await requestJson(this.baseUrl+'/transaction/initialize',{
      method:'POST',
      headers:{
        Authorization:'Bearer '+this.secretKey,
        'Content-Type':'application/json',
        Accept:'application/json'
      },
      body:JSON.stringify({
        email:input.customerEmail,
        amount:String(input.amountMinor),
        currency:input.currencyCode,
        reference:input.providerReference,
        callback_url:this.callbackUrl,
        metadata:JSON.stringify({
          swiftservePaymentIntentId:input.paymentIntentId,
          bookingId:input.bookingId,
          businessId:input.businessId
        })
      })
    });
    if(data?.status!==true||typeof data?.data?.authorization_url!=='string'){
      throw new Error('Paystack did not return a checkout URL.');
    }
    return {
      checkoutUrl:data.data.authorization_url,
      providerReference:data.data.reference||input.providerReference,
      accessCode:data.data.access_code||null
    };
  }

  async verifyTransaction(input){
    if(!this.isConfigured())throw new Error('Paystack is not configured.');
    const data=await requestJson(this.baseUrl+'/transaction/verify/'+encodeURIComponent(input.providerReference),{
      method:'GET',
      headers:{Authorization:'Bearer '+this.secretKey,Accept:'application/json'}
    });
    const transaction=data?.data;
    return {
      success:data?.status===true&&transaction?.status==='success',
      reference:transaction?.reference||null,
      transactionReference:transaction?.id===undefined?null:String(transaction.id),
      amountMinor:Number(transaction?.amount),
      currencyCode:typeof transaction?.currency==='string'?transaction.currency.toUpperCase():null,
      status:transaction?.status||'unknown'
    };
  }

  verifyWebhook(rawBody,headers){
    const signature=headers['paystack-signature'];
    const secret=process.env.PAYSTACK_WEBHOOK_SECRET||'';
    if(typeof signature==='string'&&secret){
      const parts=signature.split(',');
      const timestampPart=parts.find(item=>item.startsWith('t='));
      const timestamp=timestampPart?Number(timestampPart.slice(2)):NaN;
      if(!Number.isFinite(timestamp)||Math.abs(Date.now()/1000-timestamp)>300)return false;
      const expected=createHmac('sha512',secret).update(String(timestamp)+'.').update(rawBody).digest('hex');
      const signatures=parts.filter(item=>item.startsWith('v1=')).map(item=>{
        const separator=item.indexOf(':');
        return separator>=0?item.slice(separator+1):item.slice(3);
      });
      return signatures.some(candidate=>equalHex(candidate,expected));
    }

    const legacy=headers['x-paystack-signature'];
    if(typeof legacy==='string'&&this.secretKey){
      const expected=createHmac('sha512',this.secretKey).update(rawBody).digest('hex');
      return equalHex(legacy,expected);
    }
    return false;
  }

  parseWebhook(payload){
    const data=payload?.data||{};
    return {
      eventId:typeof data.id==='number'||typeof data.id==='string'?String(data.id):String(data.reference||''),
      eventType:typeof payload?.event==='string'?payload.event:'unknown',
      providerReference:typeof data.reference==='string'?data.reference:null,
      transactionReference:data.id===undefined?null:String(data.id),
      success:payload?.event==='charge.success'||data.status==='success'
    };
  }
}

class FlutterwaveGateway{
  constructor(){
    this.code='flutterwave';
    this.secretKey=process.env.FLUTTERWAVE_SECRET_KEY||'';
    this.webhookSecret=process.env.FLUTTERWAVE_WEBHOOK_SECRET_HASH||'';
    this.callbackUrl=process.env.PAYMENT_RETURN_URL||'';
    this.currencies=parseConfiguredCurrencies(
      'FLUTTERWAVE_SUPPORTED_CURRENCIES',
      ['NGN','GHS','KES','UGX','TZS','ZAR','EUR','GBP','USD','RWF','XOF','XAF']
    );
    this.baseUrl=process.env.FLUTTERWAVE_API_BASE_URL||'https://api.flutterwave.com/v3';
  }

  isConfigured(){return Boolean(this.secretKey&&this.callbackUrl&&this.webhookSecret);}
  supportsCurrency(currency){return this.currencies.has(currency.toUpperCase());}

  async initialize(input){
    if(!this.isConfigured())throw new Error('Flutterwave is not configured for this environment.');
    if(!this.supportsCurrency(input.currencyCode))throw new Error('Flutterwave is not enabled for this currency in the current market configuration.');
    const data=await requestJson(this.baseUrl+'/payments',{
      method:'POST',
      headers:{
        Authorization:'Bearer '+this.secretKey,
        'Content-Type':'application/json',
        Accept:'application/json'
      },
      body:JSON.stringify({
        tx_ref:input.providerReference,
        amount:toMajorUnits(input.amountMinor,input.currencyCode),
        currency:input.currencyCode,
        redirect_url:this.callbackUrl,
        customer:{
          email:input.customerEmail,
          name:input.customerName||input.customerEmail,
          phonenumber:input.customerPhone||undefined
        },
        customizations:{
          title:'SwiftServe household service',
          description:'Payment for booking '+input.bookingReference
        },
        meta:{
          swiftserve_payment_intent_id:input.paymentIntentId,
          booking_id:input.bookingId,
          business_id:input.businessId
        }
      })
    });
    if(data?.status!=='success'||typeof data?.data?.link!=='string'){
      throw new Error('Flutterwave did not return a checkout URL.');
    }
    return {checkoutUrl:data.data.link,providerReference:input.providerReference,accessCode:null};
  }

  async verifyTransaction(input){
    if(!this.isConfigured())throw new Error('Flutterwave is not configured.');
    if(!input.transactionReference)throw new Error('Flutterwave transaction ID is required for verification.');
    const data=await requestJson(this.baseUrl+'/transactions/'+encodeURIComponent(input.transactionReference)+'/verify',{
      method:'GET',
      headers:{Authorization:'Bearer '+this.secretKey,Accept:'application/json'}
    });
    const transaction=data?.data;
    return {
      success:data?.status==='success'&&transaction?.status==='successful',
      reference:transaction?.tx_ref||null,
      transactionReference:transaction?.id===undefined?null:String(transaction.id),
      amountMinor:Math.round(Number(transaction?.amount)*Math.pow(10,currencyMinorUnits(String(transaction?.currency||'').toUpperCase()))),
      currencyCode:typeof transaction?.currency==='string'?transaction.currency.toUpperCase():null,
      status:transaction?.status||'unknown'
    };
  }

  verifyWebhook(rawBody,headers){
    if(!this.webhookSecret)return false;
    const simple=headers['verif-hash'];
    if(typeof simple==='string')return equalText(simple,this.webhookSecret);
    const signature=headers['flutterwave-signature'];
    if(typeof signature==='string'){
      const expected=createHmac('sha256',this.webhookSecret).update(rawBody).digest('base64');
      return equalText(signature,expected);
    }
    return false;
  }

  parseWebhook(payload){
    const data=payload?.data||{};
    return {
      eventId:data.id===undefined?String(data.tx_ref||''):String(data.id),
      eventType:typeof payload?.event==='string'?payload.event:'unknown',
      providerReference:typeof data.tx_ref==='string'?data.tx_ref:null,
      transactionReference:data.id===undefined?null:String(data.id),
      success:data.status==='successful'||payload?.event==='charge.completed'
    };
  }
}

export function getPaymentGateway(providerCode=null){
  const selected=(providerCode||process.env.PAYMENT_PROVIDER||'').toLowerCase();
  if(selected==='paystack'){
    const gateway=new PaystackGateway();
    return gateway.isConfigured()?gateway:null;
  }
  if(selected==='flutterwave'){
    const gateway=new FlutterwaveGateway();
    return gateway.isConfigured()?gateway:null;
  }
  return null;
}

export function parsePaymentWebhook(providerCode,payload){
  const code=String(providerCode||'').toLowerCase();
  if(code==='paystack')return new PaystackGateway().parseWebhook(payload);
  if(code==='flutterwave')return new FlutterwaveGateway().parseWebhook(payload);
  return null;
}

export function verifyPaymentWebhookSignature(providerCode,rawBody,headers){
  const code=String(providerCode||'').toLowerCase();
  if(code==='paystack')return new PaystackGateway().verifyWebhook(rawBody,headers);
  if(code==='flutterwave')return new FlutterwaveGateway().verifyWebhook(rawBody,headers);
  return false;
}
