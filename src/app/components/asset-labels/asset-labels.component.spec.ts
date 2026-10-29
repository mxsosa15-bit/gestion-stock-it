import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { AssetLabelsComponent } from './asset-labels.component';
import { HardwareAssetsService } from '../../services/hardware-assets.service';

describe('AssetLabelsComponent', () => {
  it('creates an independent label view', async () => {
    await TestBed.configureTestingModule({
      imports: [AssetLabelsComponent, HttpClientTestingModule],
    })
      .overrideComponent(AssetLabelsComponent, { set: { template: '' } })
      .compileComponents();

    TestBed.inject(HardwareAssetsService);
    const fixture = TestBed.createComponent(AssetLabelsComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });
});
