const helper = require('@/common/helper');
const requestHelper = require('@/pages/biz-vendor/request-helper');

helper();
requestHelper();

import('@/pages/biz-vendor/request.js?root=pages/biz-vendor').then((m) => m.getData());
import('@/mp_ecard_sdk/protocol/sdk.js?root=mp_ecard_sdk/protocol').then((m) => m);
