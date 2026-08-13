export const INVENTORY_LAB = 'inventory-concurrency';
export const INVENTORY_SCHEMA = 'lab_inventory_concurrency';
export const INVENTORY_TOPIC = 'lab.inventory-concurrency.stock.changed';
export const INVENTORY_CONSUMER_GROUP_SUFFIX = 'inventory-concurrency.db-writer';
export const INVENTORY_TOPIC_PARTITIONS = 3;

export const inventoryStockKey = (skuId: string): string =>
  `lab:inventory-concurrency:stock:${skuId}`;

export const inventoryInitLockKey = (skuId: string): string =>
  `lab:inventory-concurrency:init-lock:${skuId}`;

export const REDIS_DECREASE_SCRIPT = `
local stock = redis.call('GET', KEYS[1])
if not stock then
  return -1
end
local current = tonumber(stock)
local quantity = tonumber(ARGV[1])
if current < quantity then
  return -2
end
return redis.call('DECRBY', KEYS[1], quantity)
`;

export const REDIS_RELEASE_INIT_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;
