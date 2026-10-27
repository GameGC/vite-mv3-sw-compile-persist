import BgPlatform from './BgPlatform';

export const mockPlatforms: BgPlatform[] = [
  {
    id: 'linkedin',
    name: 'LinkedIn Jobs',
    url: 'https://www.linkedin.com/jobs',
    tabKey: 'linkedin_tab',
    refreshRate: 30,
    refreshType: 'soft',
    turnedOn: true,
  },
  {
    id: 'indeed',
    name: 'Indeed Jobs',
    url: 'https://www.indeed.com/jobs',
    tabKey: 'indeed_tab',
    refreshRate: 60,
    refreshType: 'hard',
    turnedOn: true,
  },
  {
    id: 'glassdoor',
    name: 'Glassdoor Jobs',
    url: 'https://www.glassdoor.com/jobs',
    tabKey: 'glassdoor_tab',
    refreshRate: 45,
    refreshType: 'soft',
    turnedOn: false,
  },
];

export async function loadPlatforms(): Promise<BgPlatform[]> {
  return [...mockPlatforms];
}
