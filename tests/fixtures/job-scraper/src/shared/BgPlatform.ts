export default interface BgPlatform {
  id: string;
  name?: string;
  url: string;
  tabKey: string;
  refreshRate: number;
  refreshType?: 'soft' | 'hard';
  turnedOn: boolean;
}
