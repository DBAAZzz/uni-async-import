// 陷阱字符串：业务代码里带双引号的 JSON 字面量，内容与 vendor chunk 名完全相同。
// emit 阶段做字符串删除的实现会误删它（P0-3），chunk graph 实现不会。
const VENDOR_LABEL = '["pages/biz-vendor/common/vendor"]';

module.exports = function helper() {
  return 'COMMON_HELPER:' + VENDOR_LABEL;
};
